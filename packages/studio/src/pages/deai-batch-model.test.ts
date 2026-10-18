import { describe, expect, it } from "vitest";
import {
  compactDeAISuffix,
  deAIBatchPayload,
  deAIChapterBadge,
  deAIJobFromSse,
  deAIProgressPercent,
  deAIResultRows,
  defaultDeAIRange,
  formatDeAIScore,
  lineDiff,
  lineDiffRows,
  mergeDeAIJob,
  mergeDeAIRecords,
  nextPreviewChapter,
  previewChaptersFromJob,
  recordMapFromList,
} from "./deai-batch-model";

describe("defaultDeAIRange", () => {
  it("uses a span for contiguous chapters and all for gaps", () => {
    expect(defaultDeAIRange([])).toBe("");
    expect(defaultDeAIRange([1, 2, 3])).toBe("1-3");
    expect(defaultDeAIRange([3])).toBe("3-3");
    expect(defaultDeAIRange([1, 3, 5])).toBe("all");
  });
});

describe("deAIProgressPercent", () => {
  it("clamps done/total to 0–100", () => {
    expect(deAIProgressPercent(undefined)).toBe(0);
    expect(deAIProgressPercent({ done: 0, total: 0 })).toBe(0);
    expect(deAIProgressPercent({ done: 1, total: 4 })).toBe(25);
    expect(deAIProgressPercent({ done: 9, total: 4 })).toBe(100);
  });
});

describe("deAIBatchPayload", () => {
  it("requires confirm for apply and omits empty skill", () => {
    expect(deAIBatchPayload({ range: " 1-3 ", mode: "score-only" })).toEqual({
      range: "1-3",
      mode: "score-only",
    });
    expect(deAIBatchPayload({ range: "all", mode: "preview", skill: "custom" })).toEqual({
      range: "all",
      mode: "preview",
      skill: "custom",
    });
    expect(() => deAIBatchPayload({ range: "1-2", mode: "apply" })).toThrow(/confirm/);
    expect(deAIBatchPayload({ range: "1-2", mode: "apply", confirmApply: true })).toEqual({
      range: "1-2",
      mode: "apply",
      confirm: true,
    });
  });
});

describe("sse job merge", () => {
  it("picks the latest matching deai:progress event", () => {
    const job = deAIJobFromSse([
      { event: "log", data: null },
      { event: "deai:progress", data: { jobId: "a", status: "running", mode: "preview", progress: { done: 0, total: 2 }, chapters: {} } },
      { event: "deai:progress", data: { jobId: "b", status: "running", mode: "preview", progress: { done: 1, total: 2 }, chapters: {} } },
      { event: "deai:progress", data: { jobId: "a", status: "completed", mode: "preview", progress: { done: 2, total: 2 }, chapters: { "1": { status: "ok", scoreBefore: 80, scoreAfter: 40, written: true } } } },
    ], "a");
    expect(job?.status).toBe("completed");
    expect(job?.progress.done).toBe(2);
    expect(mergeDeAIJob(job, {
      jobId: "a",
      status: "completed",
      mode: "preview",
      progress: { done: 2, total: 2 },
      chapters: job!.chapters,
      report: { rows: [{ chapter: 1, status: "ok", scoreBefore: 80, scoreAfter: 40, written: true }] },
    })?.report?.rows).toHaveLength(1);
  });
});

describe("result rows and preview cursor", () => {
  it("lists written preview chapters and advances past decided ones", () => {
    const job = {
      jobId: "j",
      status: "completed" as const,
      mode: "preview" as const,
      progress: { done: 2, total: 2 },
      chapters: {
        "1": { status: "ok", scoreBefore: 70, scoreAfter: 40, written: true },
        "2": { status: "ok", scoreBefore: 20, scoreAfter: 20, written: false },
        "3": { status: "warn", scoreBefore: 80, scoreAfter: 55, written: true },
      },
    };
    expect(deAIResultRows(job).map((row) => row.chapter)).toEqual([1, 2, 3]);
    expect(previewChaptersFromJob(job)).toEqual([1, 3]);
    expect(nextPreviewChapter([1, 3], 1, new Set([1]))).toBe(3);
    expect(nextPreviewChapter([1, 3], 3, new Set([1, 3]))).toBeNull();
  });
});

describe("lineDiff", () => {
  it("builds a side-by-side line diff", () => {
    const rows = lineDiffRows("hello\nworld", "hello\nthere");
    expect(lineDiff("hello\nworld", "hello\nthere")).toEqual([
      { kind: "same", text: "hello" },
      { kind: "del", text: "world" },
      { kind: "add", text: "there" },
    ]);
    expect(rows).toEqual([
      { left: { text: "hello", kind: "same" }, right: { text: "hello", kind: "same" } },
      { left: { text: "world", kind: "del" }, right: { text: "there", kind: "add" } },
    ]);
  });
});

describe("chapter badges", () => {
  it("maps score/status to badge tone and compact suffix", () => {
    expect(deAIChapterBadge(undefined)).toBeNull();
    expect(deAIChapterBadge({ score: 41.6, status: "ok" })).toEqual({ score: 42, status: "ok", tone: "ok" });
    expect(deAIChapterBadge({ score: 80, status: "failed" })?.tone).toBe("fail");
    expect(compactDeAISuffix({ score: 80, status: "failed" })).toBe(" ·deAI80!");
    expect(compactDeAISuffix({ score: 55, status: "warned" })).toBe(" ·deAI55~");
    expect(formatDeAIScore(null)).toBe("—");
  });

  it("prefers persisted deai.json over last batch scores", () => {
    const merged = mergeDeAIRecords(
      [{ chapterNumber: 1, score: 33, status: "ok" }],
      {
        "1": { status: "warn", scoreBefore: 90, scoreAfter: 70, written: true },
        "2": { status: "ok", scoreBefore: 20, scoreAfter: 18, written: false },
      },
    );
    expect(merged).toEqual([
      { chapterNumber: 1, score: 33, status: "ok" },
      { chapterNumber: 2, score: 18, status: "ok" },
    ]);
    expect(recordMapFromList(merged).get(2)?.score).toBe(18);
  });
});
