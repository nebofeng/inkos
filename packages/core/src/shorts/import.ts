import { cp, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createProductionRunSnapshot, writeProductionRunSnapshot } from "../production/harness.js";
import { isSafeBookId } from "../utils/book-id.js";
import { countAnswerChars } from "./quality.js";
import {
  createPendingReview,
  readReview,
  reviewFileExists,
  writeReview,
  type ReviewFile,
  type ReviewState,
} from "./review.js";

export type ShortImportLayout = "flat" | "inkos";
export type ShortImportAction = "imported" | "skipped" | "overwritten" | "would-import" | "would-overwrite";

export interface ShortImportItem {
  readonly id: string;
  readonly layout: ShortImportLayout;
  readonly sourceDir: string;
  readonly destDir: string;
  readonly action: ShortImportAction;
  readonly state: ReviewState;
  readonly title?: string;
  readonly batch?: string;
  readonly reason?: string;
}

export interface ShortImportOptions {
  readonly projectRoot: string;
  readonly from: string;
  readonly outDir?: string;
  readonly batch?: string;
  readonly dryRun?: boolean;
  readonly force?: boolean;
}

export interface ShortImportResult {
  readonly items: ReadonlyArray<ShortImportItem>;
  readonly imported: number;
  readonly skipped: number;
  readonly published: number;
  readonly pending: number;
}

interface DetectedStory {
  readonly id: string;
  readonly layout: ShortImportLayout;
  readonly sourceDir: string;
  readonly batch?: string;
}

export async function importShorts(options: ShortImportOptions): Promise<ShortImportResult> {
  const outDir = options.outDir ?? "shorts";
  const sourceRoot = resolve(options.from);
  const stories = await discoverStories(sourceRoot, options.batch);
  const items: ShortImportItem[] = [];
  for (const story of stories) {
    items.push(await importOne(options.projectRoot, outDir, story, options));
  }
  const imported = items.filter((item) => item.action === "imported" || item.action === "overwritten").length;
  const skipped = items.filter((item) => item.action === "skipped").length;
  const published = items.filter((item) => item.state === "published").length;
  const pending = items.filter((item) => item.state === "pending").length;
  return { items, imported, skipped, published, pending };
}

export async function discoverStories(from: string, batchOverride?: string): Promise<DetectedStory[]> {
  const found: DetectedStory[] = [];
  await walk(from, batchOverride, found, 0);
  found.sort((a, b) => a.id.localeCompare(b.id));
  return found;
}

async function walk(dir: string, batchOverride: string | undefined, out: DetectedStory[], depth: number): Promise<void> {
  const detected = await detectStory(dir, batchOverride);
  if (detected) {
    out.push(detected);
    return;
  }
  if (depth > 6) return;
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const child = join(dir, name);
    const info = await stat(child).catch(() => undefined);
    if (!info?.isDirectory()) continue;
    await walk(child, batchOverride, out, depth + 1);
  }
}

async function detectStory(dir: string, batchOverride?: string): Promise<DetectedStory | undefined> {
  const hasStatus = await exists(join(dir, "status.json"));
  const hasFinal = await exists(join(dir, "final", "full.md")) || await exists(join(dir, "zhihu-answer.md"));
  const hasMeta = await exists(join(dir, "zhihu-answer-meta.json"));
  if (hasStatus && hasFinal) {
    const id = await readInkosId(dir);
    if (!id) return undefined;
    return { id, layout: "inkos", sourceDir: dir, batch: batchOverride ?? inferBatch(dir) };
  }
  if (hasMeta) {
    const meta = await readJson(join(dir, "zhihu-answer-meta.json"));
    const id = typeof meta?.id === "string" && isSafeBookId(meta.id) ? meta.id : basename(dir);
    if (!isSafeBookId(id)) return undefined;
    return { id, layout: "flat", sourceDir: dir, batch: batchOverride ?? inferBatch(dir) };
  }
  return undefined;
}

async function importOne(
  projectRoot: string,
  outDir: string,
  story: DetectedStory,
  options: ShortImportOptions,
): Promise<ShortImportItem> {
  const destDir = join(projectRoot, outDir, story.id);
  const destExists = await exists(destDir);
  if (destExists && !options.force) {
    const existing = await readReview(destDir);
    return {
      id: story.id,
      layout: story.layout,
      sourceDir: story.sourceDir,
      destDir,
      action: "skipped",
      state: existing?.state ?? "pending",
      batch: story.batch,
      reason: "id already exists",
    };
  }
  if (options.dryRun) {
    const planned = await planReview(story);
    return {
      id: story.id,
      layout: story.layout,
      sourceDir: story.sourceDir,
      destDir,
      action: destExists ? "would-overwrite" : "would-import",
      state: planned.state,
      title: planned.title,
      batch: planned.batch,
    };
  }
  if (destExists) {
    await rmrf(destDir);
  }
  if (story.layout === "flat") {
    await importFlat(story, destDir);
  } else {
    await importInkos(story, destDir);
  }
  const review = await writeImportedReview(story, destDir);
  return {
    id: story.id,
    layout: story.layout,
    sourceDir: story.sourceDir,
    destDir,
    action: destExists ? "overwritten" : "imported",
    state: review.state,
    title: review.title,
    batch: review.batch,
  };
}

async function importFlat(story: DetectedStory, destDir: string): Promise<void> {
  const src = story.sourceDir;
  await mkdir(join(destDir, "final"), { recursive: true });
  await mkdir(join(destDir, "outline"), { recursive: true });
  await mkdir(join(destDir, "reviews"), { recursive: true });
  await mkdir(join(destDir, "drafts"), { recursive: true });
  await mkdir(join(destDir, "imported"), { recursive: true });
  const answer = await readFile(join(src, "zhihu-answer.md"), "utf-8").catch(() => "");
  await writeFile(join(destDir, "final", "zhihu-answer.md"), answer, "utf-8");
  await writeFile(join(destDir, "final", "full.md"), answer, "utf-8");
  await copyIfExists(join(src, "zhihu-answer-draft.md"), join(destDir, "drafts", "zhihu-draft.md"));
  await copyIfExists(join(src, "outline.md"), join(destDir, "outline", "v002.md"));
  await copyIfExists(join(src, "review.md"), join(destDir, "reviews", "draft-v001.md"));
  await copyIfExists(join(src, "zhihu-answer-meta.json"), join(destDir, "imported", "zhihu-answer-meta.json"));
  await copyIfExists(join(src, "posted.json"), join(destDir, "imported", "posted.json"));
  await copyIfExists(join(src, "posted.png"), join(destDir, "imported", "posted.png"));
  await writeCompleteStatus(destDir, story.id, ["final/zhihu-answer.md", "final/full.md"]);
}

async function importInkos(story: DetectedStory, destDir: string): Promise<void> {
  await cp(story.sourceDir, destDir, { recursive: true });
  await mkdir(join(destDir, "imported"), { recursive: true });
  if (await exists(join(destDir, "status.json"))) {
    await rename(join(destDir, "status.json"), join(destDir, "imported", "status.original.json"));
  }
  if (await exists(join(destDir, "zhihu-answer.md")) && !await exists(join(destDir, "final", "zhihu-answer.md"))) {
    await mkdir(join(destDir, "final"), { recursive: true });
    const answer = await readFile(join(destDir, "zhihu-answer.md"), "utf-8");
    await writeFile(join(destDir, "final", "zhihu-answer.md"), answer, "utf-8");
  }
  await copyIfExists(join(destDir, "zhihu-answer-meta.json"), join(destDir, "imported", "zhihu-answer-meta.json"));
  await writeCompleteStatus(destDir, story.id, ["final/zhihu-answer.md", "final/full.md"]);
}

async function writeImportedReview(story: DetectedStory, destDir: string): Promise<ReviewFile> {
  const planned = await planReview(story);
  if (await reviewFileExists(destDir) && planned.state !== "published") {
    // force overwrite still replaces production files; keep human published if we didn't plan published
  }
  await writeReview(destDir, planned);
  return planned;
}

async function planReview(story: DetectedStory): Promise<ReviewFile> {
  const meta = await readJson(join(story.sourceDir, "zhihu-answer-meta.json"));
  const posted = await readJson(join(story.sourceDir, "posted.json"));
  const title = pickString(meta?.title) ?? pickString(meta?.title_required_prefix) ?? story.id;
  const prefix = pickString(meta?.title_required_prefix);
  const questionUrl = pickString(posted?.question_url) ?? pickString(meta?.zhihu_question);
  const answerUrl = pickString(posted?.answer_url) ?? pickString(meta?.answer_url);
  const published = Boolean(posted?.ok || posted?.answer_url || meta?.posted === true)
    && Boolean(answerUrl);
  const notPosted = meta?.not_posted === true && !posted;
  const state: ReviewState = published && !notPosted ? "published" : "pending";
  const history = state === "published"
    ? [
        { from: "pending" as const, to: "confirmed" as const, at: isoNow(), by: "import" },
        { from: "confirmed" as const, to: "published" as const, at: isoNow(), by: "import" },
      ]
    : [];
  const pending = createPendingReview({
    source: "import",
    platform: "zhihu",
    batch: story.batch,
    finalPath: "final/zhihu-answer.md",
    title,
    titleRequiredPrefix: prefix,
    questionUrl,
    answerUrl: answerUrl ?? null,
    publishedAt: state === "published" ? (pickString(posted?.posted_at) ?? pickString(meta?.posted_at) ?? isoNow()) : null,
    confirmedAt: state === "published" ? isoNow() : null,
    history,
  });
  return state === "published" ? { ...pending, state: "published" } : pending;
}

async function writeCompleteStatus(destDir: string, id: string, artifacts: ReadonlyArray<string>): Promise<void> {
  let chars = 0;
  try {
    const markdown = await readFile(join(destDir, "final", "zhihu-answer.md"), "utf-8");
    chars = countAnswerChars(markdown, "zh");
  } catch {
    // ignore
  }
  await writeProductionRunSnapshot({
    rootDir: destDir,
    runPath: "status.json",
    run: createProductionRunSnapshot({
      kind: "short-fiction",
      id,
      status: "complete",
      stage: "imported",
      artifacts,
      observations: chars
        ? [{
            metric: "final-length",
            expected: { min: 2200, max: 3500, unit: "zh_chars" },
            actual: { value: chars, unit: "zh_chars" },
            severity: chars >= 2200 && chars <= 3500 ? "info" : "warning",
            repairable: false,
          }]
        : [],
    }),
  });
}

function inferBatch(dir: string): string | undefined {
  const parent = basename(dirname(dir));
  if (/^\d{4}-\d{2}-\d{2}$/.test(parent)) return parent;
  return undefined;
}

async function readInkosId(dir: string): Promise<string | undefined> {
  const status = await readJson(join(dir, "status.json"));
  if (typeof status?.id === "string" && isSafeBookId(status.id)) return status.id;
  const base = basename(dir);
  return isSafeBookId(base) ? base : undefined;
}

async function copyIfExists(from: string, to: string): Promise<void> {
  if (!await exists(from)) return;
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isoNow(): string {
  return new Date().toISOString();
}

async function rmrf(path: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(path, { recursive: true, force: true });
}
