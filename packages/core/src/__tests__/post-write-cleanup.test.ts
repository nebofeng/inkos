import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChapterMeta } from "../models/chapter.js";
import type { DetectionConfig } from "../models/project.js";
import type { AgentContext } from "../agents/base.js";
import { postWriteCleanup } from "../pipeline/post-write-cleanup.js";
import type { DeslopResult } from "../pipeline/deslop-runner.js";

const NOW = "2026-10-09T12:00:00.000Z";

const detection: DetectionConfig = {
  provider: "custom",
  apiUrl: "https://detector.example.com/api",
  apiKeyEnv: "DETECT_KEY",
  threshold: 0.5,
  enabled: true,
  autoRewrite: true,
  maxRetries: 2,
};

const reviserCtx = {
  client: {} as AgentContext["client"],
  model: "test-model",
  projectRoot: "/tmp",
} satisfies AgentContext;

function meta(overrides?: Partial<ChapterMeta>): ChapterMeta {
  return {
    number: 1,
    title: "开篇",
    status: "ready-for-review",
    wordCount: 12,
    createdAt: NOW,
    updatedAt: NOW,
    auditIssues: [],
    lengthWarnings: [],
    ...overrides,
  };
}

async function seedBook(): Promise<{ bookDir: string; index: ChapterMeta[]; save: ReturnType<typeof vi.fn> }> {
  const root = await mkdtemp(join(tmpdir(), "inkos-cleanup-"));
  const bookDir = join(root, "book");
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await writeFile(join(bookDir, "chapters", "0001_opening.md"), "# 第1章 开篇\n\n原文。\n", "utf-8");
  const index = [meta()];
  const save = vi.fn(async (next: ReadonlyArray<ChapterMeta>) => {
    index.splice(0, index.length, ...next);
  });
  return { bookDir, index, save };
}

describe("postWriteCleanup", () => {
  it("runs deslop then detect and marks publishEligible on pass", async () => {
    const { bookDir, index, save } = await seedBook();
    const runDeslop = vi.fn(async (): Promise<DeslopResult> => ({
      chapterNumber: 1,
      status: "ok",
      content: "清理后。",
      wordCount: 4,
      attempts: 1,
    }));
    const detectChapter = vi.fn(async () => ({
      chapterNumber: 1,
      passed: true,
      detection: { score: 0.2, provider: "custom", detectedAt: NOW },
    }));
    const detectAndRewrite = vi.fn();

    const result = await postWriteCleanup({
      bookId: "demo",
      chapterNumber: 1,
      bookDir,
      deslop: { enabled: true, keepOriginal: true, maxRetries: 2, mode: "full" },
      detection,
      reviserCtx,
      loadChapterIndex: async () => index,
      saveChapterIndex: save,
      now: () => NOW,
      runDeslop,
      detectChapter,
      detectAndRewrite,
      createReviser: async () => ({ reviseChapter: async () => ({ revisedContent: "", wordCount: 0 }) }),
    });

    expect(runDeslop).toHaveBeenCalledOnce();
    expect(detectChapter).toHaveBeenCalledOnce();
    expect(detectAndRewrite).not.toHaveBeenCalled();
    expect(result.publishEligible).toBe(true);
    expect(index[0]?.deslopStatus).toBe("ok");
    expect(index[0]?.detectionPassed).toBe(true);
    expect(index[0]?.publishEligible).toBe(true);
  });

  it("skips detect when deslop fails and is not publish eligible", async () => {
    const { bookDir, index, save } = await seedBook();
    const detectChapter = vi.fn();
    const detectAndRewrite = vi.fn();
    const onError = vi.fn();

    const result = await postWriteCleanup({
      bookId: "demo",
      chapterNumber: 1,
      bookDir,
      deslop: { enabled: true, keepOriginal: true, maxRetries: 2, mode: "full" },
      detection,
      reviserCtx,
      loadChapterIndex: async () => index,
      saveChapterIndex: save,
      onError,
      now: () => NOW,
      runDeslop: async () => ({
        chapterNumber: 1,
        status: "failed",
        content: "原文。",
        wordCount: 3,
        attempts: 2,
        error: "timeout",
      }),
      detectChapter,
      detectAndRewrite,
      createReviser: async () => ({ reviseChapter: async () => ({ revisedContent: "", wordCount: 0 }) }),
    });

    expect(result.skippedDetect).toBe(true);
    expect(detectChapter).not.toHaveBeenCalled();
    expect(detectAndRewrite).not.toHaveBeenCalled();
    expect(result.publishEligible).toBe(false);
    expect(index[0]?.deslopStatus).toBe("failed");
    expect(index[0]?.publishEligible).toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  it("still invokes autoRewrite when detect fails the threshold", async () => {
    const { bookDir, index, save } = await seedBook();
    const detectAndRewrite = vi.fn(async () => ({
      chapterNumber: 1,
      originalScore: 0.9,
      finalScore: 0.3,
      attempts: 1,
      passed: true,
      finalContent: "改写后。",
    }));

    const result = await postWriteCleanup({
      bookId: "demo",
      chapterNumber: 1,
      bookDir,
      deslop: { enabled: true, keepOriginal: true, maxRetries: 2, mode: "full" },
      detection,
      reviserCtx,
      loadChapterIndex: async () => index,
      saveChapterIndex: save,
      now: () => NOW,
      runDeslop: async () => ({
        chapterNumber: 1,
        status: "ok",
        content: "清理后。",
        wordCount: 4,
        attempts: 1,
      }),
      detectChapter: async () => ({
        chapterNumber: 1,
        passed: false,
        detection: { score: 0.9, provider: "custom", detectedAt: NOW },
      }),
      detectAndRewrite,
      createReviser: async () => ({ reviseChapter: async () => ({ revisedContent: "", wordCount: 0 }) }),
    });

    expect(detectAndRewrite).toHaveBeenCalledOnce();
    expect(result.detectionPassed).toBe(true);
    expect(result.publishEligible).toBe(true);
    expect(index[0]?.detectionScore).toBe(0.3);
  });

  it("treats missing publish fields as not eligible", async () => {
    const { bookDir, index, save } = await seedBook();
    await postWriteCleanup({
      bookId: "demo",
      chapterNumber: 1,
      bookDir,
      deslop: { enabled: false, keepOriginal: true, maxRetries: 2, mode: "full" },
      reviserCtx,
      loadChapterIndex: async () => index,
      saveChapterIndex: save,
      now: () => NOW,
      runDeslop: async () => ({
        chapterNumber: 1,
        status: "skipped",
        content: "原文。",
        wordCount: 3,
        attempts: 0,
      }),
      createReviser: async () => ({ reviseChapter: async () => ({ revisedContent: "", wordCount: 0 }) }),
    });

    expect(index[0]?.deslopStatus).toBe("skipped");
    expect(index[0]?.detectionPassed).toBeUndefined();
    expect(index[0]?.publishEligible).toBe(false);
  });
});
