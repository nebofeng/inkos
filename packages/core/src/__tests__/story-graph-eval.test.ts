import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countContradictions, evaluateStoryGraphRetrieval, formatEvalSummary, NoiseInjectingExtractor } from "../story-graph/eval.js";
import { loadTruthRoster } from "../story-graph/truth.js";
import { FixtureExtractor, writeFixtureBook } from "./fixtures/story-graph-fixture.js";

describe("story-graph eval harness", () => {
  let root: string;
  let bookDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-graph-eval-"));
    bookDir = join(root, "books", "b1");
    await writeFixtureBook(bookDir);
    await writeFile(join(bookDir, "story", "chapter_summaries.md"), [
      "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...[1, 2, 3, 4, 5, 6].map((n) => `| ${n} | 占位${n} | 林砚 | 占位事件${n} | 无 | 无 | 平 | 过渡 |`),
    ].join("\n"), "utf-8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("replays chapters on a copy and scores old vs new retrieval", async () => {
    const result = await evaluateStoryGraphRetrieval({ bookDir, extractor: new FixtureExtractor() });
    expect(result.chapters).toBe(5);
    expect(result.rows.map((row) => row.chapter)).toEqual([2, 3, 4, 5, 6]);
    for (const row of result.rows) {
      expect(row.next.tokens).toBeGreaterThanOrEqual(row.old.tokens);
      if (row.old.characterRecall !== null) expect(row.next.characterRecall!).toBeGreaterThanOrEqual(row.old.characterRecall);
    }
    expect(result.summary.next.characterRecall!).toBeGreaterThan(result.summary.old.characterRecall!);
    expect(result.summary.contradictionsInContext).toBe(0);
    expect(result.summary.reconcileConflicts["relationship:dropped"]).toBe(1);
    expect(formatEvalSummary(result)).toContain("character recall");
    // Source book untouched (no journal written into it).
    expect(await readdir(join(bookDir, "story"))).not.toContain("graph");
  });

  it("injected contradictions are caught by reconciliation and never reach the context", async () => {
    const roster = await loadTruthRoster(bookDir);
    const noisy = new NoiseInjectingExtractor(new FixtureExtractor(), roster);
    const result = await evaluateStoryGraphRetrieval({ bookDir, extractor: noisy });
    expect(noisy.injected.quotes).toBe(6);
    expect(noisy.injected.statuses).toBeGreaterThan(0);
    expect(noisy.injected.relations).toBeGreaterThan(0);
    expect(result.summary.reconcileConflicts["dialogue:dropped"]).toBe(6 + 1);
    expect(result.summary.reconcileConflicts["status:truth-wins"]).toBeGreaterThanOrEqual(noisy.injected.statuses);
    expect(result.summary.contradictionsInContext).toBe(0);
  });

  it("counts structured contradictions in rendered graph text", async () => {
    const roster = await loadTruthRoster(bookDir);
    expect(countContradictions("- 老秦：看门人；状态：失踪\n- 林砚 — 韩铎：盟友；强度0.9", roster)).toBe(2);
    expect(countContradictions("- 老秦：看门人；状态：已死亡\n- 林砚 — 韩铎：对头；强度0.9", roster)).toBe(0);
  });
});
