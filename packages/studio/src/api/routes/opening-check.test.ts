import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpeningCheckConfigSchema } from "../../../../core/src/models/project.js";
import { readOpeningCheckReport } from "../../../../core/src/opening-check/report.js";
import { resolveBookOpeningHardGate } from "../../../../core/src/pipeline/publish-eligibility.js";
import { isSafeBookId } from "../../../../core/src/utils/book-id.js";
import { ApiError } from "../errors.js";

vi.mock("@actalk/inkos-core", () => ({ isSafeBookId }));

const { registerOpeningCheckRoutes } = await import("./opening-check.js");

const tmpDirs: string[] = [];

async function seedProject(): Promise<{ root: string; bookId: string; bookDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "inkos-studio-opening-check-"));
  tmpDirs.push(root);
  const bookId = "sifa";
  const bookDir = join(root, "books", bookId);
  await mkdir(join(bookDir, "story"), { recursive: true });
  await writeFile(join(root, "inkos.json"), JSON.stringify({
    name: "demo",
    version: "0.1.0",
    language: "zh",
  }, null, 2), "utf-8");
  await writeFile(join(bookDir, "book.json"), JSON.stringify({
    id: bookId,
    title: "司法所",
    platform: "other",
    genre: "xuanhuan",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }, null, 2), "utf-8");
  return { root, bookId, bookDir };
}

function createApp(root: string) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    }
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: { code: "INTERNAL_ERROR", message } }, 500);
  });
  registerOpeningCheckRoutes(app, {
    root,
    readReport: readOpeningCheckReport,
    resolveHardGate: resolveBookOpeningHardGate,
    parseProjectOpeningCheck: (raw) => {
      const parsed = OpeningCheckConfigSchema.safeParse(raw ?? {});
      return parsed.success ? parsed.data : undefined;
    },
  });
  return app;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("opening-check routes", () => {
  it("fail-closes when the book has no report", async () => {
    const { root, bookId } = await seedProject();
    const res = await createApp(root).request(`/api/v1/books/${bookId}/opening-check`);
    expect(res.status).toBe(200);
    const body = await res.json() as { report: null; hardGate: { passed: boolean; reason?: string } };
    expect(body.report).toBeNull();
    expect(body.hardGate.passed).toBe(false);
    expect(body.hardGate.reason).toContain("缺开篇检查报告");
  });

  it("returns persisted hard-gate failure", async () => {
    const { root, bookId, bookDir } = await seedProject();
    await writeFile(join(bookDir, "story", "opening-check.json"), JSON.stringify({
      bookId,
      chapters: [1, 2, 3],
      generatedAt: "2026-10-21T00:00:00.000Z",
      binding: { service: "custom", model: "stub" },
      items: [
        { id: "5a", title: "金手指", criterion: "", verdict: "fail", quotes: [], quoteChecks: [], suggestion: "补金手指" },
        { id: "5b", title: "黄金500字钩", criterion: "", verdict: "pass", quotes: [], quoteChecks: [], suggestion: "" },
        { id: 7, title: "前期小 boss", criterion: "", verdict: "pass", quotes: [], quoteChecks: [], suggestion: "" },
      ],
    }, null, 2), "utf-8");
    const parsed = OpeningCheckConfigSchema.safeParse({});
    expect(parsed.success ? parsed.data.hardGate : false).toBe(true);
    const res = await createApp(root).request(`/api/v1/books/${bookId}/opening-check`);
    expect(res.status).toBe(200);
    const body = await res.json() as { hardGate: { passed: boolean; reason?: string } };
    expect(body.hardGate.passed).toBe(false);
    expect(body.hardGate.reason).toContain("无金手指");
  });

  it("uses injected loaders without the core barrel", async () => {
    const { root, bookId } = await seedProject();
    const app = new Hono();
    registerOpeningCheckRoutes(app, {
      root,
      readReport: async () => undefined,
      resolveHardGate: async () => ({
        passed: false,
        mode: "hard",
        blocks: [{ id: "5a", title: "金手指", verdict: "fail", suggestion: "补金手指" }],
        reason: "开篇硬闸未通过：无金手指（不通过）",
      }),
    });
    const res = await app.request(`/api/v1/books/${bookId}/opening-check`);
    expect(res.status).toBe(200);
    const body = await res.json() as { hardGate: { reason?: string } };
    expect(body.hardGate.reason).toContain("无金手指");
    expect(vi.isMockFunction(readOpeningCheckReport)).toBe(false);
  });
});
