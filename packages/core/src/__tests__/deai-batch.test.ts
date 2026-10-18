import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  clampDeAIBatchConcurrency,
  listExistingChapterNumbers,
  parseDeAIRange,
  rollbackDeAIBatch,
  runDeAIBatch,
} from "../deai/index.js";

const CLEAN = Array.from({ length: 40 }, (_, i) => `「走。」他说。她点头。这是第${i}句对话。`).join("\n");
const BOOKISH = "他随即伫立在原地，眼眸宛如古井，唇角氤氲，心底蔓延涌起，须臾宛如静谧斑驳，俨然难以名状。命运一往无前，他知道这一刻信念。".repeat(4);

async function seedProject(opts?: {
  readonly status?: string;
  readonly chapters?: number;
  readonly body?: string;
}): Promise<{ projectRoot: string; bookDir: string; bookId: string }> {
  const projectRoot = await mkdtemp(join(tmpdir(), "inkos-deai-batch-"));
  const bookId = "demo";
  const bookDir = join(projectRoot, "books", bookId);
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await writeFile(join(projectRoot, "inkos.json"), JSON.stringify({
    name: "demo",
    version: "0.1.0",
  }), "utf-8");
  const now = "2026-01-01T00:00:00.000Z";
  await writeFile(join(bookDir, "book.json"), JSON.stringify({
    id: bookId,
    title: "Demo",
    platform: "other",
    genre: "xuanhuan",
    status: opts?.status ?? "active",
    createdAt: now,
    updatedAt: now,
  }), "utf-8");
  const count = opts?.chapters ?? 3;
  const body = opts?.body ?? BOOKISH;
  for (let n = 1; n <= count; n++) {
    await writeFile(
      join(bookDir, "chapters", `000${n}_ch.md`),
      `# 第${n}章\n\n${body}\n`,
      "utf-8",
    );
  }
  return { projectRoot, bookDir, bookId };
}

async function readChapter(bookDir: string, n: number): Promise<string> {
  return readFile(join(bookDir, "chapters", `000${n}_ch.md`), "utf-8");
}

describe("parseDeAIRange", () => {
  const existing = [1, 2, 3, 5, 9, 20];

  it("parses inclusive spans, lists, and all", () => {
    expect(parseDeAIRange("1-3", existing)).toEqual([1, 2, 3]);
    expect(parseDeAIRange("3,5,9", existing)).toEqual([3, 5, 9]);
    expect(parseDeAIRange("all", existing)).toEqual([1, 2, 3, 5, 9, 20]);
    expect(parseDeAIRange("1-2,9", existing)).toEqual([1, 2, 9]);
  });

  it("rejects empty, inverted, garbage, and missing chapters", () => {
    expect(() => parseDeAIRange("", existing)).toThrow(/empty/i);
    expect(() => parseDeAIRange("foo", existing)).toThrow(/invalid range token/i);
    expect(() => parseDeAIRange("5-3", existing)).toThrow(/invalid range/i);
    expect(() => parseDeAIRange("1-20", existing)).toThrow(/do not exist: 4, 6/);
    expect(() => parseDeAIRange("all", [])).toThrow(/no chapters/i);
  });
});

describe("clampDeAIBatchConcurrency", () => {
  it("defaults to 1 and caps at 3", () => {
    expect(clampDeAIBatchConcurrency(undefined)).toBe(1);
    expect(clampDeAIBatchConcurrency(0)).toBe(1);
    expect(clampDeAIBatchConcurrency(2)).toBe(2);
    expect(clampDeAIBatchConcurrency(3)).toBe(3);
    expect(clampDeAIBatchConcurrency(9)).toBe(3);
  });
});

describe("runDeAIBatch", () => {
  it("score-only writes nothing to chapters and calls no LLM", async () => {
    const { projectRoot, bookDir, bookId } = await seedProject();
    const before = await readChapter(bookDir, 1);
    const rewriter = vi.fn(async () => CLEAN);
    const report = await runDeAIBatch({
      projectRoot,
      bookId,
      range: "1-3",
      mode: "score-only",
      rewriter,
    });
    expect(rewriter).not.toHaveBeenCalled();
    expect(report.rows).toHaveLength(3);
    expect(report.rows.every((row) => row.written === false)).toBe(true);
    expect(report.rows.every((row) => row.status === "ok")).toBe(true);
    expect(report.rows[0]?.scoreBefore).toBe(report.rows[0]?.scoreAfter);
    expect(await readChapter(bookDir, 1)).toBe(before);
    expect(await readChapter(bookDir, 2)).toBe(before.replace("第1章", "第2章"));
    const files = await readdir(join(bookDir, "chapters"));
    expect(files.some((file) => file.includes(".pre-deslop"))).toBe(false);
    const bak = await readdir(join(bookDir, "chapters", ".deai-bak")).catch(() => [] as string[]);
    expect(bak).toEqual([]);
  });

  it("apply writes rewritten chapters and a timestamped backup", async () => {
    const { projectRoot, bookDir, bookId } = await seedProject();
    const original = await readChapter(bookDir, 2);
    const rewriter = vi.fn(async () => CLEAN);
    const report = await runDeAIBatch({
      projectRoot,
      bookId,
      range: "2",
      mode: "apply",
      rewriter,
      now: () => new Date("2026-04-01T12:00:00.000Z"),
    });
    expect(rewriter).toHaveBeenCalledTimes(1);
    expect(report.rows).toEqual([expect.objectContaining({
      chapter: 2,
      written: true,
      status: "ok",
    })]);
    expect(await readChapter(bookDir, 2)).toContain("「走。」他说。");
    expect(await readChapter(bookDir, 2)).not.toBe(original);
    const bak = await readFile(
      join(bookDir, "chapters", ".deai-bak", "2026-04-01T12-00-00-000Z", "0002_ch.md"),
      "utf-8",
    );
    expect(bak).toBe(original);
  });

  it("rollback restores files from a backup timestamp", async () => {
    const { projectRoot, bookDir, bookId } = await seedProject();
    const original = await readChapter(bookDir, 1);
    const ts = "2026-04-01T12-00-00-000Z";
    const report = await runDeAIBatch({
      projectRoot,
      bookId,
      range: "1",
      mode: "apply",
      rewriter: async () => CLEAN,
      now: () => new Date("2026-04-01T12:00:00.000Z"),
    });
    expect(report.ts).toBe(ts);
    expect(await readChapter(bookDir, 1)).toContain("「走。」他说。");
    const rolled = await rollbackDeAIBatch({ projectRoot, bookId, from: ts });
    expect(rolled.restored).toEqual(["0001_ch.md"]);
    expect(await readChapter(bookDir, 1)).toBe(original);
  });

  it("resume skips completed chapters after a simulated interruption", async () => {
    const { projectRoot, bookId } = await seedProject({ chapters: 3 });
    const controller = new AbortController();
    const rewriter = vi.fn(async () => CLEAN);
    const first = await runDeAIBatch({
      projectRoot,
      bookId,
      range: "1-3",
      mode: "apply",
      rewriter,
      signal: controller.signal,
      onProgress: (event) => {
        if (event.phase === "done" && event.chapter === 2) controller.abort();
      },
    });
    expect(first.stoppedReason).toBe("aborted");
    expect(first.chapters["1"]?.status).toBe("ok");
    expect(first.chapters["2"]?.status).toBe("ok");
    expect(first.chapters["3"]?.status).toBe("pending");
    expect(rewriter).toHaveBeenCalledTimes(2);

    const second = await runDeAIBatch({
      projectRoot,
      bookId,
      range: "1-3",
      mode: "apply",
      rewriter,
      resume: true,
    });
    expect(rewriter).toHaveBeenCalledTimes(3);
    expect(second.chapters["3"]?.status).toBe("ok");
    expect(second.chapters["3"]?.written).toBe(true);
    expect(second.skipped).toBe(2);
    expect(second.rows.map((row) => row.chapter)).toEqual([1, 2, 3]);
  });

  it("caps concurrency at 3", async () => {
    const { projectRoot, bookId } = await seedProject({ chapters: 6 });
    let inflight = 0;
    let maxInflight = 0;
    const rewriter = vi.fn(async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((resolve) => setTimeout(resolve, 80));
      inflight -= 1;
      return CLEAN;
    });
    await runDeAIBatch({
      projectRoot,
      bookId,
      range: "all",
      mode: "apply",
      concurrency: 9,
      rewriter,
    });
    expect(maxInflight).toBeLessThanOrEqual(3);
    expect(maxInflight).toBe(3);
    expect(rewriter).toHaveBeenCalledTimes(6);
  });

  it("refuses paused and dropped books unless force is set", async () => {
    const paused = await seedProject({ status: "paused", chapters: 1 });
    const rewriter = vi.fn(async () => CLEAN);
    await expect(runDeAIBatch({
      projectRoot: paused.projectRoot,
      bookId: paused.bookId,
      range: "1",
      mode: "score-only",
      rewriter,
    })).rejects.toThrow(/paused/);
    expect(rewriter).not.toHaveBeenCalled();

    const dropped = await seedProject({ status: "dropped", chapters: 1 });
    await expect(runDeAIBatch({
      projectRoot: dropped.projectRoot,
      bookId: dropped.bookId,
      range: "all",
      mode: "score-only",
    })).rejects.toThrow(/dropped/);

    const forced = await runDeAIBatch({
      projectRoot: paused.projectRoot,
      bookId: paused.bookId,
      range: "1",
      mode: "score-only",
      force: true,
      rewriter,
    });
    expect(forced.rows[0]?.status).toBe("ok");
  });

  it("preview writes story/deai-preview and leaves chapters untouched", async () => {
    const { projectRoot, bookDir, bookId } = await seedProject({ chapters: 1 });
    const original = await readChapter(bookDir, 1);
    await runDeAIBatch({
      projectRoot,
      bookId,
      range: "1",
      mode: "preview",
      rewriter: async () => CLEAN,
    });
    expect(await readChapter(bookDir, 1)).toBe(original);
    const preview = await readFile(join(bookDir, "story", "deai-preview", "1.md"), "utf-8");
    expect(preview).toContain("「走。」他说。");
  });
});

describe("listExistingChapterNumbers", () => {
  it("ignores sidecars and non-canonical files", async () => {
    const { bookDir } = await seedProject({ chapters: 2 });
    await writeFile(join(bookDir, "chapters", "0001_ch.md.pre-deslop"), "old", "utf-8");
    await writeFile(join(bookDir, "chapters", "notes.md"), "x", "utf-8");
    expect(await listExistingChapterNumbers(bookDir)).toEqual([1, 2]);
  });
});
