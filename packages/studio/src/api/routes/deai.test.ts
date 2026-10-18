import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../errors.js";
import { createStudioServer } from "../server.js";
import { registerDeAIRoutes, type DeAIRouteDeps } from "./deai.js";

const CLEAN = Array.from({ length: 40 }, (_, i) => `「走。」他说。她点头。这是第${i}句对话。`).join("\n");
const BOOKISH = "他随即伫立在原地，眼眸宛如古井，唇角氤氲，心底蔓延涌起，须臾宛如静谧斑驳，俨然难以名状。命运一往无前，他知道这一刻信念。".repeat(4);

const VALID_SKILL = [
  "---",
  "name: custom-deai",
  "description: Project deAI skill for tests.",
  "kind: deai",
  "scorer: builtin-ai-flavor",
  "---",
  "Rewrite flagged paragraphs. Keep facts.",
  "",
].join("\n");

const INVALID_SKILL = [
  "---",
  "name: bad-deai",
  "description: Broken regex.",
  "kind: deai",
  "bannedPatterns:",
  '  - "("',
  "---",
  "nope",
  "",
].join("\n");

async function seedProject(opts?: { readonly chapters?: number }): Promise<{
  root: string;
  bookId: string;
  bookDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "inkos-studio-deai-"));
  const bookId = "demo";
  const bookDir = join(root, "books", bookId);
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await writeFile(join(root, "inkos.json"), JSON.stringify({
    name: "demo",
    version: "0.1.0",
    language: "zh",
  }, null, 2), "utf-8");
  const now = "2026-01-01T00:00:00.000Z";
  await writeFile(join(bookDir, "book.json"), JSON.stringify({
    id: bookId,
    title: "Demo",
    platform: "other",
    genre: "xuanhuan",
    status: "active",
    createdAt: now,
    updatedAt: now,
  }, null, 2), "utf-8");
  const count = opts?.chapters ?? 3;
  for (let n = 1; n <= count; n++) {
    await writeFile(
      join(bookDir, "chapters", `000${n}_ch.md`),
      `# 第${n}章\n\n${BOOKISH}\n`,
      "utf-8",
    );
  }
  return { root, bookId, bookDir };
}

function createApp(root: string, extra: Partial<DeAIRouteDeps> = {}) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    }
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: { code: "INTERNAL_ERROR", message } }, 500);
  });
  registerDeAIRoutes(app, { root, broadcast: () => undefined, ...extra });
  return app;
}

async function waitForJob(
  app: Hono,
  bookId: string,
  jobId: string,
  predicate: (job: { status: string; chapters: Record<string, { status: string; written?: boolean }>; report?: unknown }) => boolean,
) {
  await vi.waitFor(async () => {
    const res = await app.request(`/api/v1/books/${bookId}/deai/batch/${jobId}`);
    expect(res.status).toBe(200);
    const job = await res.json() as { status: string; chapters: Record<string, { status: string; written?: boolean }>; report?: unknown };
    expect(predicate(job)).toBe(true);
  }, { timeout: 15_000, interval: 30 });
}

describe("deAI studio routes", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 8 })));
  });

  it("lists builtin deAI skills with source/valid/errors", async () => {
    const { root } = await seedProject();
    roots.push(root);
    const app = createApp(root);
    const res = await app.request("/api/v1/deai/skills");
    expect(res.status).toBe(200);
    const json = await res.json() as {
      skills: Array<{ id: string; source: string; valid: boolean; errors: unknown[]; description?: string }>;
    };
    expect(json.skills.length).toBeGreaterThan(0);
    const builtin = json.skills.find((skill) => skill.id === "inkos-story-deslop");
    expect(builtin).toMatchObject({ source: "builtin", valid: true, errors: [] });
    expect(builtin?.description).toBeTruthy();
  });

  it("validates skill content and rejects invalid regex", async () => {
    const { root } = await seedProject();
    roots.push(root);
    const app = createApp(root);

    const ok = await app.request("/api/v1/deai/skills/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: VALID_SKILL }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ valid: true, errors: [] });

    const bad = await app.request("/api/v1/deai/skills/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: INVALID_SKILL }),
    });
    expect(bad.status).toBe(200);
    const badJson = await bad.json() as { valid: boolean; errors: Array<{ code: string }> };
    expect(badJson.valid).toBe(false);
    expect(badJson.errors.some((error) => error.code === "regex")).toBe(true);
  });

  it("save rejects invalid content and cannot overwrite builtins (writes project override)", async () => {
    const { root } = await seedProject();
    roots.push(root);
    const app = createApp(root);

    const rejected = await app.request("/api/v1/deai/skills/bad-deai", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "project", content: INVALID_SKILL }),
    });
    expect(rejected.status).toBe(400);
    const rejectedJson = await rejected.json() as { valid: boolean; errors: Array<{ code: string }> };
    expect(rejectedJson.valid).toBe(false);
    expect(rejectedJson.errors.some((error) => error.code === "regex")).toBe(true);

    const show = await app.request("/api/v1/deai/skills/inkos-story-deslop");
    expect(show.status).toBe(200);
    const shown = await show.json() as { source: string; content: string };
    expect(shown.source).toBe("builtin");

    const saved = await app.request("/api/v1/deai/skills/inkos-story-deslop", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "project", content: shown.content }),
    });
    expect(saved.status).toBe(200);
    const savedJson = await saved.json() as { ok: boolean; skill: { source: string; path: string } };
    expect(savedJson.ok).toBe(true);
    expect(savedJson.skill.source).toBe("project");
    expect(savedJson.skill.path).toContain(`${join(".agents", "skills", "inkos-story-deslop", "SKILL.md")}`);

    const listed = await app.request("/api/v1/deai/skills");
    const listJson = await listed.json() as { skills: Array<{ id: string; source: string }> };
    expect(listJson.skills.find((skill) => skill.id === "inkos-story-deslop")?.source).toBe("project");
  });

  it("reads and writes project and book deAI config without dropping legacy keys", async () => {
    const { root, bookId } = await seedProject();
    roots.push(root);
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      name: "demo",
      version: "0.1.0",
      deslop: { enabled: true, mode: "local", maxRetries: 2 },
      qualityGate: { onFail: "warn", maxRetries: 1 },
    }, null, 2), "utf-8");
    const app = createApp(root);

    const before = await app.request("/api/v1/deai/config");
    expect(before.status).toBe(200);
    const beforeJson = await before.json() as { effective: { enabled: boolean; skill: string } };
    expect(beforeJson.effective.enabled).toBe(true);
    expect(beforeJson.effective.skill).toBe("inkos-story-deslop");

    const put = await app.request("/api/v1/deai/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "project",
        deAI: { enabled: true, skill: "inkos-story-deslop-full", aiFlavorThreshold: 55, onFail: "retry", maxRetries: 2 },
      }),
    });
    expect(put.status).toBe(200);
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8")) as Record<string, unknown>;
    expect(raw.deslop).toEqual({ enabled: true, mode: "local", maxRetries: 2 });
    expect(raw.qualityGate).toEqual({ onFail: "warn", maxRetries: 1 });
    expect(raw.deAI).toMatchObject({ skill: "inkos-story-deslop-full", onFail: "retry" });

    const bookPut = await app.request(`/api/v1/books/${bookId}/deai`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deAI: { enabled: true, aiFlavorThreshold: 40, onFail: "pause" } }),
    });
    expect(bookPut.status).toBe(200);
    const bookGet = await app.request(`/api/v1/deai/config?bookId=${bookId}`);
    const bookJson = await bookGet.json() as { effective: { aiFlavorThreshold: number; onFail: string }; deAI: { onFail: string } };
    expect(bookJson.effective.aiFlavorThreshold).toBe(40);
    expect(bookJson.effective.onFail).toBe("pause");
    expect(bookJson.deAI.onFail).toBe("pause");
  });

  it("starts a batch job, reports progress, and cancel stops further chapters", async () => {
    const { root, bookId, bookDir } = await seedProject({ chapters: 3 });
    roots.push(root);
    let started = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const rewriter = vi.fn(async () => {
      started += 1;
      if (started >= 2) await gate;
      return CLEAN;
    });
    const app = createApp(root, { rewriter });

    const applyDenied = await app.request(`/api/v1/books/${bookId}/deai/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ range: "1-3", mode: "apply" }),
    });
    expect(applyDenied.status).toBe(400);

    const start = await app.request(`/api/v1/books/${bookId}/deai/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ range: "1-3", mode: "apply", confirm: true }),
    });
    expect(start.status).toBe(202);
    const { jobId } = await start.json() as { jobId: string };
    expect(jobId).toBeTruthy();

    await vi.waitFor(() => expect(started).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    const cancel = await app.request(`/api/v1/books/${bookId}/deai/batch/${jobId}/cancel`, { method: "POST" });
    expect(cancel.status).toBe(200);
    releaseGate();

    await waitForJob(app, bookId, jobId, (job) => Boolean(job.report) && (job.status === "cancelled" || job.status === "completed"));
    const done = await (await app.request(`/api/v1/books/${bookId}/deai/batch/${jobId}`)).json() as {
      status: string;
      chapters: Record<string, { status: string }>;
      report?: { stoppedReason?: string };
    };
    expect(done.status).toBe("cancelled");
    expect(done.report?.stoppedReason ?? "aborted").toBe("aborted");
    expect(done.chapters["3"]?.status === "pending" || done.chapters["3"] == null).toBe(true);
    expect(started).toBe(2);
    const ch3 = await readFile(join(bookDir, "chapters", "0003_ch.md"), "utf-8");
    expect(ch3).toContain("眼眸宛如古井");
  });

  it("preview does not write chapters until accept; reject discards", async () => {
    const { root, bookId, bookDir } = await seedProject({ chapters: 2 });
    roots.push(root);
    const original1 = await readFile(join(bookDir, "chapters", "0001_ch.md"), "utf-8");
    const original2 = await readFile(join(bookDir, "chapters", "0002_ch.md"), "utf-8");
    const app = createApp(root, { rewriter: async () => CLEAN, now: () => new Date("2026-04-01T12:00:00.000Z") });

    const start = await app.request(`/api/v1/books/${bookId}/deai/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ range: "1-2", mode: "preview" }),
    });
    expect(start.status).toBe(202);
    const { jobId } = await start.json() as { jobId: string };
    await waitForJob(app, bookId, jobId, (job) => job.status === "completed");

    expect(await readFile(join(bookDir, "chapters", "0001_ch.md"), "utf-8")).toBe(original1);
    expect(await readFile(join(bookDir, "chapters", "0002_ch.md"), "utf-8")).toBe(original2);
    expect(await readFile(join(bookDir, "story", "deai-preview", "1.md"), "utf-8")).toContain("「走。」他说。");

    const accept = await app.request(`/api/v1/books/${bookId}/deai/preview/1/accept`, { method: "POST" });
    expect(accept.status).toBe(200);
    const accepted = await readFile(join(bookDir, "chapters", "0001_ch.md"), "utf-8");
    expect(accepted).toContain("「走。」他说。");
    expect(accepted).not.toBe(original1);
    const bak = await readFile(join(bookDir, "chapters", ".deai-bak", "2026-04-01T12-00-00-000Z", "0001_ch.md"), "utf-8");
    expect(bak).toBe(original1);

    const reject = await app.request(`/api/v1/books/${bookId}/deai/preview/2/reject`, { method: "POST" });
    expect(reject.status).toBe(200);
    expect(await readFile(join(bookDir, "chapters", "0002_ch.md"), "utf-8")).toBe(original2);
    await expect(readFile(join(bookDir, "story", "deai-preview", "2.md"), "utf-8")).rejects.toThrow();
  });

  it("is registered from createStudioServer", async () => {
    const { root } = await seedProject();
    roots.push(root);
    const app = createStudioServer({} as never, root);
    const res = await app.request("/api/v1/deai/skills");
    expect(res.status).toBe(200);
  });
});
