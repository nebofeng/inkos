import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_STORY_GRAPH_CONFIG } from "../story-graph/config.js";
import { buildEdgeViews, retrieveStoryGraphContext } from "../story-graph/retrieval.js";
import { backfillStoryGraph } from "../story-graph/service.js";
import { estimateTextTokens } from "../llm/provider.js";
import { parseCharacterMatrix } from "../story-graph/truth.js";
import { FIXTURE_MATRIX, FixtureExtractor, writeFixtureBook } from "./fixtures/story-graph-fixture.js";

describe("story-graph retrieval", () => {
  let root: string;
  let bookDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-graph-retrieval-"));
    bookDir = join(root, "books", "b1");
    await writeFixtureBook(bookDir);
    await backfillStoryGraph({ bookDir, extractor: new FixtureExtractor() });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const text = (entries: ReadonlyArray<{ excerpt: string }>) => entries.map((entry) => entry.excerpt).join("\n");

  it("starts from characters named in the goal (aliases too) and expands relationship hops", async () => {
    const context = await retrieveStoryGraphContext({
      bookDir,
      chapterNumber: 7,
      goal: "岚姐追问铜钥匙的来历",
      writeTrace: true,
    });
    expect(context.trace.seeds).toEqual(expect.arrayContaining(["周岚"]));
    // Item owner pulls in 林砚 as a seed via the item entity.
    expect(context.trace.seeds).toEqual(expect.arrayContaining(["林砚"]));
    const names = context.trace.expanded.map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining(["韩铎", "老秦"]));
    const sources = context.entries.map((entry) => entry.source);
    expect(sources).toEqual(["story/graph#characters", "story/graph#relationships", "story/graph#events", "story/graph#dialogue"]);
    const all = text(context.entries);
    expect(all).toContain("又称");
    expect(all).toContain("老秦：");
    expect(all).toContain("状态：已死亡"); // truth wins over extraction "alive"
    expect(all).toContain("第6章 周岚→林砚：“这是老秦的东西。”");
    expect(all).not.toContain("我一定会报仇"); // unverifiable quote never stored
    expect(all).not.toMatch(/林砚 — 韩铎：盟友/); // contradicting edge dropped
    expect(all).toMatch(/林砚 — 韩铎：对头/);
    const trace = JSON.parse(await readFile(join(bookDir, "story", "runtime", "chapter-0007.graph.json"), "utf-8"));
    expect(trace.engine).toBe("story-graph/v1");
  });

  it("never leaks chapters at or after the chapter being written", async () => {
    const context = await retrieveStoryGraphContext({ bookDir, chapterNumber: 4, goal: "林砚回到码头" });
    const all = text(context.entries);
    expect(all).not.toMatch(/第[4-9]章/);
    expect(all).not.toContain("铜钥匙");
  });

  it("falls back to the protagonist when the goal names nobody", async () => {
    const context = await retrieveStoryGraphContext({ bookDir, chapterNumber: 7, goal: "下雨了" });
    expect(context.trace.seeds[0]).toBe("林砚");
  });

  it("respects the token budget and drops low-priority items first", async () => {
    const tight = await retrieveStoryGraphContext({
      bookDir, chapterNumber: 7, goal: "周岚和林砚商量对付韩铎", config: { budgetTokens: 200 },
    });
    expect(tight.trace.usedTokens).toBeLessThanOrEqual(200);
    expect(tight.trace.droppedForBudget).toBeGreaterThan(0);
    const roughTokens = tight.entries.reduce((sum, entry) => sum + estimateTextTokens(entry.excerpt), 0);
    expect(roughTokens).toBeLessThanOrEqual(200);
    // Seed cards survive the squeeze.
    expect(text(tight.entries)).toContain("- 周岚：");
    const roomy = await retrieveStoryGraphContext({ bookDir, chapterNumber: 7, goal: "周岚和林砚商量对付韩铎" });
    expect(roomy.trace.usedTokens).toBeGreaterThan(tight.trace.usedTokens);
    expect(roomy.trace.usedTokens).toBeLessThanOrEqual(DEFAULT_STORY_GRAPH_CONFIG.budgetTokens);
  });

  it("hops=1 does not reach second-degree characters", async () => {
    const one = await retrieveStoryGraphContext({ bookDir, chapterNumber: 7, goal: "韩铎", config: { hops: 1 } });
    const two = await retrieveStoryGraphContext({ bookDir, chapterNumber: 7, goal: "韩铎", config: { hops: 2 } });
    expect(one.trace.expanded.every((entry) => entry.hop <= 1)).toBe(true);
    expect(two.trace.expanded.some((entry) => entry.hop === 2)).toBe(true);
  });

  it("de-prioritises events from chapters BM25 already covered", async () => {
    const eventsOf = (ctx: { entries: ReadonlyArray<{ source: string; excerpt: string }> }) =>
      ctx.entries.find((entry) => entry.source === "story/graph#events")?.excerpt ?? "";
    let diverged = false;
    for (let budget = 200; budget <= 420; budget += 20) {
      const base = await retrieveStoryGraphContext({ bookDir, chapterNumber: 7, goal: "林砚", config: { budgetTokens: budget } });
      const covered = await retrieveStoryGraphContext({
        bookDir, chapterNumber: 7, goal: "林砚", config: { budgetTokens: budget }, coveredChapters: [6],
      });
      // A covered chapter's event is never kept when the uncovered run dropped it.
      if (eventsOf(covered).includes("第6章")) expect(eventsOf(base)).toContain("第6章");
      if (eventsOf(base).includes("第6章") && !eventsOf(covered).includes("第6章")) diverged = true;
    }
    expect(diverged).toBe(true);
  });

  it("collapses edge observations into typed spans with start/end chapters", () => {
    const roster = { characters: parseCharacterMatrix("") };
    const views = buildEdgeViews([
      { chapter: 2, source: "甲", target: "乙", type: "盟友", strength: 0.5, status: "active", note: "" },
      { chapter: 3, source: "乙", target: "甲", type: "盟友", strength: 0.7, status: "active", note: "" },
      { chapter: 5, source: "甲", target: "乙", type: "对手", strength: 0.9, status: "active", note: "" },
      { chapter: 6, source: "甲", target: "乙", type: "对手", strength: 0.9, status: "ended", note: "" },
      { chapter: 9, source: "甲", target: "乙", type: "future", strength: 1, status: "active", note: "" },
    ], roster, 8);
    expect(views).toEqual([expect.objectContaining({
      a: "乙", b: "甲", type: "对手", startChapter: 5, endChapter: 6,
      previous: [{ type: "盟友", from: 2, to: 3 }],
    })]);
  });

  it("truth relation overrides a contradicting graph edge at query time", () => {
    const roster = { characters: parseCharacterMatrix(FIXTURE_MATRIX) };
    const suppressed: string[] = [];
    const views = buildEdgeViews([
      { chapter: 4, source: "林砚", target: "韩铎", type: "盟友", strength: 0.8, status: "active", note: "" },
    ], roster, 7, suppressed);
    expect(suppressed).toHaveLength(1);
    expect(views.find((view) => view.a === "林砚" && view.b === "韩铎")!.type).toBe("追债的对头");
  });
});
