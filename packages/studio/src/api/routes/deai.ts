/**
 * deAI Studio routes (RD-038 S5). Kept out of server.ts (conflict hotspot with RD-035).
 *
 * Skills, project/book deAI config, batch jobs (task-store + SSE), preview accept/reject.
 */

import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Hono } from "hono";
import {
  BookDeAIOverrideSchema,
  ProjectDeAIConfigSchema,
  getDeAISkill,
  listDeAISkills,
  parseDeAISkillMarkdown,
  readChapterMarkdown,
  resolveDeAIConfig,
  runDeAIBatch,
  type BookDeAIOverride,
  type DeAIBatchChapterState,
  type DeAIBatchMode,
  type DeAIBatchReport,
  type DeAIRewriter,
  type DeAISkillError,
  type ProjectDeAIConfig,
} from "@actalk/inkos-core";
import { ApiError } from "../errors.js";
import { isSafeBookId } from "../safety.js";
import { saveStudioTaskSnapshot } from "../task-store.js";

const BATCH_MODES = new Set<DeAIBatchMode>(["score-only", "preview", "apply"]);

export interface DeAIRouteDeps {
  readonly root: string;
  readonly broadcast: (event: string, data: unknown) => void;
  readonly rewriter?: DeAIRewriter;
  readonly runBatch?: typeof runDeAIBatch;
  readonly now?: () => Date;
}

interface DeAIBatchJob {
  jobId: string;
  bookId: string;
  status: "running" | "completed" | "cancelled" | "error";
  mode: DeAIBatchMode;
  range: string;
  skill?: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  error?: string;
  progress: { done: number; total: number; current?: number };
  chapters: Record<string, DeAIBatchChapterState>;
  report?: DeAIBatchReport;
}

export function deAIBatchSessionId(jobId: string): string {
  return `deai-batch:${jobId}`;
}

export function registerDeAIRoutes(app: Hono, deps: DeAIRouteDeps): void {
  const jobs = new Map<string, DeAIBatchJob>();
  const controllers = new Map<string, AbortController>();
  // Lazy: server.test.ts mocks @actalk/inkos-core without runDeAIBatch; accessing
  // the export at register time throws. Only resolve when a batch actually starts.
  const runBatch = (input: Parameters<typeof runDeAIBatch>[0]) =>
    (deps.runBatch ?? runDeAIBatch)(input);

  const persistJob = async (job: DeAIBatchJob): Promise<void> => {
    const execStatus = job.status === "running"
      ? "running"
      : job.status === "error"
        ? "error"
        : "completed";
    await saveStudioTaskSnapshot(deps.root, {
      version: 1,
      sessionId: deAIBatchSessionId(job.jobId),
      requestedIntent: "edit_artifact",
      updatedAt: job.updatedAt,
      execution: {
        id: job.jobId,
        tool: "deai_batch",
        label: "deAI batch",
        status: execStatus,
        details: job,
        error: job.error,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
      },
    });
  };

  const publishJob = async (job: DeAIBatchJob): Promise<void> => {
    job.updatedAt = Date.now();
    jobs.set(job.jobId, job);
    deps.broadcast("deai:progress", { ...job });
    await persistJob(job);
  };

  app.get("/api/v1/deai/skills", async (c) => {
    const bookId = optionalBookId(c.req.query("bookId"));
    const skills = await listDeAISkills({ projectRoot: deps.root, bookId });
    return c.json({
      skills: skills.map((skill) => ({
        id: skill.id,
        source: skill.source,
        valid: skill.valid,
        errors: skill.errors,
        description: skill.description,
        shadowed: skill.shadowed,
      })),
    });
  });

  app.post("/api/v1/deai/skills/validate", async (c) => {
    const body = await readJsonObject(c);
    const content = requiredString(body.content, "content");
    const parsed = parseDeAISkillMarkdown(content, {
      path: join(deps.root, ".agents", "skills", "draft", "SKILL.md"),
      source: "project",
    });
    return c.json({
      valid: parsed.valid,
      errors: parsed.errors,
      skill: parsed.valid
        ? { id: parsed.id, description: parsed.description, source: parsed.source }
        : undefined,
    });
  });

  app.get("/api/v1/deai/skills/:id", async (c) => {
    const id = c.req.param("id");
    const bookId = optionalBookId(c.req.query("bookId"));
    const skill = await getDeAISkill(id, { projectRoot: deps.root, bookId });
    if (!skill) {
      throw new ApiError(404, "DEAI_SKILL_NOT_FOUND", `deAI skill not found: ${id}`);
    }
    const content = await readFile(skill.path, "utf-8").catch(() => skill.body);
    return c.json({
      id: skill.id,
      source: skill.source,
      valid: skill.valid,
      errors: skill.errors,
      description: skill.description,
      path: skill.path,
      content,
    });
  });

  app.put("/api/v1/deai/skills/:id", async (c) => {
    const id = c.req.param("id");
    const body = await readJsonObject(c);
    const scope = body.scope === "book" ? "book" : body.scope === "project" ? "project" : undefined;
    if (!scope) {
      throw new ApiError(400, "INVALID_SKILL_SCOPE", "scope must be project or book");
    }
    const bookId = scope === "book" ? requiredBookId(body.bookId ?? c.req.query("bookId")) : optionalBookId(body.bookId);
    const content = ensureDeAIKind(requiredString(body.content, "content"));
    const dest = skillDestPath(deps.root, scope, bookId, id);
    const parsed = parseDeAISkillMarkdown(content, { path: dest, source: scope });
    if (!parsed.valid) {
      const message = parsed.errors.map((error) => error.message).join("; ") || "Invalid deAI skill";
      return c.json({
        ok: false,
        valid: false,
        errors: parsed.errors,
        error: { code: "DEAI_SKILL_INVALID", message },
      }, 400);
    }

    const existing = await getDeAISkill(id, { projectRoot: deps.root, bookId });
    if (existing?.source === "builtin" && dest === existing.path) {
      throw new ApiError(403, "DEAI_BUILTIN_READONLY", "Cannot overwrite a built-in deAI skill");
    }

    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, content, "utf-8");
    const saved = await getDeAISkill(id, { projectRoot: deps.root, bookId });
    return c.json({
      ok: true,
      valid: true,
      errors: [] as DeAISkillError[],
      skill: saved
        ? {
            id: saved.id,
            source: saved.source,
            valid: saved.valid,
            errors: saved.errors,
            description: saved.description,
            path: saved.path,
          }
        : { id, source: scope, valid: true, errors: [], path: dest },
    });
  });

  app.get("/api/v1/deai/config", async (c) => {
    const bookId = optionalBookId(c.req.query("bookId"));
    return c.json(await loadDeAIConfig(deps.root, bookId));
  });

  app.put("/api/v1/deai/config", async (c) => {
    const body = await readJsonObject(c);
    const scope = body.scope === "book" ? "book" : "project";
    const bookId = scope === "book" ? requiredBookId(body.bookId) : undefined;
    const deAI = parseConfigPayload(body.deAI, scope);
    await saveDeAIConfig(deps.root, scope, bookId, deAI);
    return c.json({ ok: true, ...(await loadDeAIConfig(deps.root, bookId)) });
  });

  app.get("/api/v1/books/:id/deai", async (c) => {
    const bookId = requiredBookId(c.req.param("id"));
    return c.json(await loadDeAIConfig(deps.root, bookId));
  });

  app.put("/api/v1/books/:id/deai", async (c) => {
    const bookId = requiredBookId(c.req.param("id"));
    const body = await readJsonObject(c);
    const deAI = parseConfigPayload(body.deAI ?? body, "book");
    await saveDeAIConfig(deps.root, "book", bookId, deAI);
    return c.json({ ok: true, ...(await loadDeAIConfig(deps.root, bookId)) });
  });

  app.post("/api/v1/books/:id/deai/batch", async (c) => {
    const bookId = requiredBookId(c.req.param("id"));
    const body = await readJsonObject(c);
    const range = requiredString(body.range, "range");
    const mode = body.mode;
    if (typeof mode !== "string" || !BATCH_MODES.has(mode as DeAIBatchMode)) {
      throw new ApiError(400, "INVALID_DEAI_MODE", "mode must be score-only, preview, or apply");
    }
    if (mode === "apply" && body.confirm !== true) {
      throw new ApiError(400, "DEAI_APPLY_CONFIRM_REQUIRED", "apply requires confirm: true (backup is always created)");
    }
    const skill = typeof body.skill === "string" && body.skill.trim() ? body.skill.trim() : undefined;

    const jobId = randomUUID();
    const controller = new AbortController();
    const now = Date.now();
    const job: DeAIBatchJob = {
      jobId,
      bookId,
      status: "running",
      mode: mode as DeAIBatchMode,
      range,
      skill,
      startedAt: now,
      updatedAt: now,
      progress: { done: 0, total: 0 },
      chapters: {},
    };
    jobs.set(jobId, job);
    controllers.set(jobId, controller);
    await persistJob(job);

    void (async () => {
      try {
        const report = await runBatch({
          projectRoot: deps.root,
          bookId,
          range,
          mode: mode as DeAIBatchMode,
          skill,
          signal: controller.signal,
          rewriter: deps.rewriter,
          now: deps.now,
          onProgress: (event) => {
            const current = jobs.get(jobId);
            if (!current) return;
            if (event.phase === "start") {
              current.progress = {
                done: current.progress.done,
                total: Math.max(current.progress.total, event.chapter),
                current: event.chapter,
              };
            } else {
              current.progress = {
                done: current.progress.done + 1,
                total: Math.max(current.progress.total, current.progress.done + 1, event.chapter),
                current: event.chapter,
              };
              if (event.status) {
                const prev = current.chapters[String(event.chapter)];
                current.chapters[String(event.chapter)] = {
                  status: event.status,
                  scoreBefore: prev?.scoreBefore ?? null,
                  scoreAfter: prev?.scoreAfter ?? null,
                  written: prev?.written ?? false,
                  error: prev?.error,
                };
              }
            }
            void publishJob(current);
          },
        });
        const current = jobs.get(jobId);
        if (!current) return;
        current.report = report;
        current.chapters = report.chapters;
        current.progress = { done: report.rows.length, total: report.rows.length };
        current.status = report.stoppedReason === "aborted" ? "cancelled" : "completed";
        current.completedAt = Date.now();
        await publishJob(current);
      } catch (error) {
        const current = jobs.get(jobId);
        if (!current) return;
        current.status = controller.signal.aborted ? "cancelled" : "error";
        current.error = error instanceof Error ? error.message : String(error);
        current.completedAt = Date.now();
        await publishJob(current);
      } finally {
        controllers.delete(jobId);
      }
    })();

    return c.json({ jobId, status: "running" }, 202);
  });

  app.get("/api/v1/books/:id/deai/batch/:jobId", async (c) => {
    const bookId = requiredBookId(c.req.param("id"));
    const jobId = c.req.param("jobId");
    const job = jobs.get(jobId);
    if (!job || job.bookId !== bookId) {
      throw new ApiError(404, "DEAI_JOB_NOT_FOUND", `deAI batch job not found: ${jobId}`);
    }
    return c.json(job);
  });

  app.post("/api/v1/books/:id/deai/batch/:jobId/cancel", async (c) => {
    const bookId = requiredBookId(c.req.param("id"));
    const jobId = c.req.param("jobId");
    const job = jobs.get(jobId);
    if (!job || job.bookId !== bookId) {
      throw new ApiError(404, "DEAI_JOB_NOT_FOUND", `deAI batch job not found: ${jobId}`);
    }
    const controller = controllers.get(jobId);
    if (!controller || job.status !== "running") {
      throw new ApiError(409, "DEAI_JOB_NOT_RUNNING", "deAI batch job is not running");
    }
    controller.abort();
    job.status = "cancelled";
    await publishJob(job);
    return c.json({ ok: true, jobId, status: "cancelled" });
  });

  app.post("/api/v1/books/:id/deai/preview/:chapter/accept", async (c) => {
    const bookId = requiredBookId(c.req.param("id"));
    const chapter = parseChapter(c.req.param("chapter"));
    const result = await acceptDeAIPreview(deps.root, bookId, chapter, deps.now);
    return c.json(result);
  });

  app.post("/api/v1/books/:id/deai/preview/:chapter/reject", async (c) => {
    const bookId = requiredBookId(c.req.param("id"));
    const chapter = parseChapter(c.req.param("chapter"));
    const result = await rejectDeAIPreview(deps.root, bookId, chapter);
    return c.json(result);
  });

  app.get("/api/v1/books/:id/deai/preview/:chapter", async (c) => {
    const bookId = requiredBookId(c.req.param("id"));
    const chapter = parseChapter(c.req.param("chapter"));
    return c.json(await readDeAIPreview(deps.root, bookId, chapter));
  });

  app.get("/api/v1/books/:id/deai/records", async (c) => {
    const bookId = requiredBookId(c.req.param("id"));
    return c.json(await loadDeAIRecords(deps.root, bookId));
  });
}

function optionalBookId(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  return requiredBookId(value);
}

function requiredBookId(value: unknown): string {
  if (typeof value !== "string" || !isSafeBookId(value)) {
    throw new ApiError(400, "INVALID_BOOK_ID", `Invalid book ID: "${String(value)}"`);
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(400, "INVALID_DEAI_PAYLOAD", `${field} must be a non-empty string`);
  }
  return value;
}

function parseChapter(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new ApiError(400, "INVALID_CHAPTER", `Invalid chapter: "${value}"`);
  }
  return n;
}

async function readJsonObject(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => {
    throw new ApiError(400, "INVALID_DEAI_PAYLOAD", "JSON body required");
  });
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "INVALID_DEAI_PAYLOAD", "JSON object required");
  }
  return body as Record<string, unknown>;
}

function deAIPreviewPath(bookDir: string, chapterNumber: number): string {
  return join(bookDir, "story", "deai-preview", `${chapterNumber}.md`);
}

function deAIBackupDir(bookDir: string, ts: string): string {
  return join(bookDir, "chapters", ".deai-bak", ts);
}

function skillDestPath(root: string, scope: "project" | "book", bookId: string | undefined, id: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safeId) throw new ApiError(400, "INVALID_SKILL_ID", `Invalid skill id: ${id}`);
  if (scope === "book") {
    if (!bookId) throw new ApiError(400, "INVALID_BOOK_ID", "book scope requires bookId");
    return join(root, "books", bookId, "skills", safeId, "SKILL.md");
  }
  return join(root, ".agents", "skills", safeId, "SKILL.md");
}

/** Built-in inkos-story-deslop has no kind; copies must. Inject so Save of a builtin works. */
export function ensureDeAIKind(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return content;
  if (/(^|\n)kind\s*:/i.test(match[1])) return content;
  return content.replace(/^---\r?\n/, "---\nkind: deai\n");
}

function parseConfigPayload(raw: unknown, scope: "project" | "book"): ProjectDeAIConfig | BookDeAIOverride {
  const parsed = scope === "book"
    ? BookDeAIOverrideSchema.safeParse(raw)
    : ProjectDeAIConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(400, "INVALID_DEAI_CONFIG", parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  return parsed.data;
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, "utf-8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    return raw as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function loadDeAIConfig(root: string, bookId?: string) {
  const projectRaw = await readJsonFile(join(root, "inkos.json")) ?? {};
  const bookRaw = bookId ? await readJsonFile(join(root, "books", bookId, "book.json")) : undefined;
  const resolved = resolveDeAIConfig({
    project: projectRaw as never,
    book: bookRaw as never,
  });
  return {
    scope: bookId ? "book" : "project",
    bookId,
    deAI: (bookId ? bookRaw?.deAI : projectRaw.deAI) ?? null,
    effective: resolved.config,
    sources: resolved.sources,
    warnings: resolved.warnings,
  };
}

async function saveDeAIConfig(
  root: string,
  scope: "project" | "book",
  bookId: string | undefined,
  deAI: ProjectDeAIConfig | BookDeAIOverride,
): Promise<void> {
  if (scope === "book") {
    if (!bookId) throw new ApiError(400, "INVALID_BOOK_ID", "book scope requires bookId");
    const path = join(root, "books", bookId, "book.json");
    const raw = await readJsonFile(path);
    if (!raw) throw new ApiError(404, "BOOK_NOT_FOUND", `Book not found: ${bookId}`);
    raw.deAI = deAI;
    raw.updatedAt = new Date().toISOString();
    await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
    return;
  }
  const path = join(root, "inkos.json");
  const raw = await readJsonFile(path) ?? {};
  raw.deAI = deAI;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
}

export async function acceptDeAIPreview(
  root: string,
  bookId: string,
  chapter: number,
  now: () => Date = () => new Date(),
): Promise<{ ok: true; chapter: number; backupTs: string; written: true }> {
  const bookDir = join(root, "books", bookId);
  const previewPath = deAIPreviewPath(bookDir, chapter);
  let preview: string;
  try {
    preview = await readFile(previewPath, "utf-8");
  } catch {
    throw new ApiError(404, "DEAI_PREVIEW_NOT_FOUND", `No deAI preview for chapter ${chapter}`);
  }
  const chapterFile = await readChapterMarkdown(bookDir, chapter);
  const ts = now().toISOString().replace(/[:.]/g, "-");
  const bakDir = deAIBackupDir(bookDir, ts);
  await mkdir(bakDir, { recursive: true });
  await copyFile(chapterFile.filePath, join(bakDir, chapterFile.fileName));
  await writeAtomic(chapterFile.filePath, preview);
  await rm(previewPath, { force: true });
  return { ok: true, chapter, backupTs: ts, written: true };
}

export async function rejectDeAIPreview(
  root: string,
  bookId: string,
  chapter: number,
): Promise<{ ok: true; chapter: number; discarded: true }> {
  const previewPath = deAIPreviewPath(join(root, "books", bookId), chapter);
  try {
    await rm(previewPath);
  } catch {
    throw new ApiError(404, "DEAI_PREVIEW_NOT_FOUND", `No deAI preview for chapter ${chapter}`);
  }
  return { ok: true, chapter, discarded: true };
}

export async function readDeAIPreview(
  root: string,
  bookId: string,
  chapter: number,
): Promise<{ chapter: number; original: string; preview: string; filename: string }> {
  const bookDir = join(root, "books", bookId);
  const previewPath = deAIPreviewPath(bookDir, chapter);
  let preview: string;
  try {
    preview = await readFile(previewPath, "utf-8");
  } catch {
    throw new ApiError(404, "DEAI_PREVIEW_NOT_FOUND", `No deAI preview for chapter ${chapter}`);
  }
  let chapterFile: { fileName: string; raw: string };
  try {
    chapterFile = await readChapterMarkdown(bookDir, chapter);
  } catch {
    throw new ApiError(404, "CHAPTER_NOT_FOUND", `Chapter ${chapter} not found`);
  }
  return { chapter, original: chapterFile.raw, preview, filename: chapterFile.fileName };
}

async function loadDeAIRecords(root: string, bookId: string): Promise<{
  bookId: string;
  updatedAt?: string;
  chapters: Array<{ chapterNumber: number; score: number | null; status: string; source: "deai" | "batch" }>;
}> {
  const bookDir = join(root, "books", bookId);
  const persisted = await readJsonFile(join(bookDir, "story", "deai.json"));
  const batch = await readJsonFile(join(bookDir, "story", "deai-batch.json"));
  const map = new Map<number, { chapterNumber: number; score: number | null; status: string; source: "deai" | "batch" }>();
  const batchChapters = batch?.chapters && typeof batch.chapters === "object" && !Array.isArray(batch.chapters)
    ? batch.chapters as Record<string, { status?: unknown; scoreAfter?: unknown; scoreBefore?: unknown }>
    : {};
  for (const [key, value] of Object.entries(batchChapters)) {
    const chapterNumber = Number(key);
    if (!Number.isInteger(chapterNumber) || chapterNumber < 1 || !value || typeof value !== "object") continue;
    const scoreAfter = typeof value.scoreAfter === "number" ? value.scoreAfter : null;
    const scoreBefore = typeof value.scoreBefore === "number" ? value.scoreBefore : null;
    map.set(chapterNumber, {
      chapterNumber,
      score: scoreAfter ?? scoreBefore,
      status: typeof value.status === "string" ? value.status : "unknown",
      source: "batch",
    });
  }
  const persistedChapters = Array.isArray(persisted?.chapters) ? persisted.chapters : [];
  for (const raw of persistedChapters) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as { chapterNumber?: unknown; score?: unknown; status?: unknown };
    const chapterNumber = typeof rec.chapterNumber === "number" ? rec.chapterNumber : Number(rec.chapterNumber);
    if (!Number.isInteger(chapterNumber) || chapterNumber < 1) continue;
    map.set(chapterNumber, {
      chapterNumber,
      score: typeof rec.score === "number" ? rec.score : null,
      status: typeof rec.status === "string" ? rec.status : "unknown",
      source: "deai",
    });
  }
  const updatedAt = typeof persisted?.updatedAt === "string"
    ? persisted.updatedAt
    : typeof batch?.ts === "string" ? batch.ts : undefined;
  return {
    bookId,
    updatedAt,
    chapters: [...map.values()].sort((a, b) => a.chapterNumber - b.chapterNumber),
  };
}

async function writeAtomic(target: string, content: string): Promise<void> {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, target);
}
