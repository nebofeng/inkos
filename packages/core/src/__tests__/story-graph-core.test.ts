import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStoryGraphConfig, DEFAULT_STORY_GRAPH_CONFIG } from "../story-graph/config.js";
import { detectExplicitStatus, NameResolver, parseCharacterMatrix, parseRelationField, relationPolarity } from "../story-graph/truth.js";
import { buildExtractionMessages, HeuristicChapterGraphExtractor, parseExtractionResponse } from "../story-graph/extract.js";
import { reconcileExtraction } from "../story-graph/reconcile.js";
import { FIXTURE_CHAPTERS, FIXTURE_EXTRACTIONS, FIXTURE_MATRIX } from "./fixtures/story-graph-fixture.js";

const roster = () => ({
  characters: parseCharacterMatrix(FIXTURE_MATRIX).map((entry) => ({ ...entry })),
});

describe("story-graph config", () => {
  it("is off by default", () => {
    expect(resolveStoryGraphConfig(undefined, {})).toEqual(DEFAULT_STORY_GRAPH_CONFIG);
    expect(DEFAULT_STORY_GRAPH_CONFIG.enabled).toBe(false);
  });

  it("reads inkos.json memory.graph and lets env override it", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-graph-config-"));
    try {
      await writeFile(join(root, "inkos.json"), JSON.stringify({
        name: "x",
        memory: { graph: { enabled: true, budgetTokens: 900, hops: 1, extractor: "heuristic", maxDialogues: 99 } },
      }), "utf-8");
      const fromFile = resolveStoryGraphConfig(root, {});
      expect(fromFile).toMatchObject({ enabled: true, budgetTokens: 900, hops: 1, extractor: "heuristic", maxDialogues: 20 });
      const fromEnv = resolveStoryGraphConfig(root, { INKOS_STORY_GRAPH: "0", INKOS_STORY_GRAPH_BUDGET: "1500", INKOS_STORY_GRAPH_HOPS: "2" });
      expect(fromEnv).toMatchObject({ enabled: false, budgetTokens: 1500, hops: 2 });
      expect(resolveStoryGraphConfig(join(root, "missing"), { INKOS_STORY_GRAPH: "on" }).enabled).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("story-graph truth roster", () => {
  it("parses names, heading/field aliases, relations and conservative status", () => {
    const parsed = parseCharacterMatrix(FIXTURE_MATRIX);
    const lin = parsed.find((entry) => entry.name === "林砚")!;
    expect(lin.aliases).toEqual(expect.arrayContaining(["阿砚", "砚哥", "小林"]));
    expect(lin.protagonist).toBe(true);
    // "不要写成已经死亡" is a negated instruction, not a death.
    expect(lin.status).toBeUndefined();
    expect(lin.relations.get("韩铎")).toBe("追债的对头");
    expect(parsed.find((entry) => entry.name === "老秦")!.status).toBe("dead");
    expect(parsed.find((entry) => entry.name === "周岚")!.aliases).toEqual(["岚姐"]);
  });

  it("detects explicit status without tripping on negations", () => {
    expect(detectExplicitStatus("已故")).toBe("dead");
    expect(detectExplicitStatus("没死，只是昏迷")).toBeUndefined();
    expect(detectExplicitStatus("下落不明")).toBe("missing");
    expect(detectExplicitStatus("并未失踪")).toBeUndefined();
  });

  it("parses relation fields and polarity", () => {
    expect([...parseRelationField("甲(盟友/Ch2) | 乙：宿敌 | 丙（师父）").entries()]).toEqual([
      ["甲", "盟友"], ["乙", "宿敌"], ["丙", "师父"],
    ]);
    expect(relationPolarity("追债的对头")).toBe("hostile");
    expect(relationPolarity("搭档")).toBe("friendly");
    expect(relationPolarity("邻居")).toBe("neutral");
  });

  it("resolves aliases with longest, non-overlapping matches", () => {
    const resolver = new NameResolver(roster().characters);
    expect(resolver.resolve("岚姐")).toBe("周岚");
    expect([...resolver.findMentions("小林对岚姐说，林砚会去。").entries()]).toEqual(
      expect.arrayContaining([["林砚", 2], ["周岚", 1]]),
    );
    expect(resolver.lastMention("周岚看了看林砚")).toBe("林砚");
  });
});

describe("story-graph extraction parsing", () => {
  it("builds a prompt with the canonical roster and verbatim-quote rule", () => {
    const [system, user] = buildExtractionMessages({
      chapterNumber: 3,
      title: "占位",
      content: FIXTURE_CHAPTERS[3]!.body,
      language: "zh",
      knownCharacters: [{ name: "林砚", aliases: ["小林"] }],
    });
    expect(system!.content).toContain("逐字复制");
    expect(system!.content).toContain("\"dialogues\"");
    expect(user!.content).toContain("林砚（小林）");
    expect(user!.content).toContain("第3章");
  });

  it("parses fenced JSON, scales strength, maps status aliases, drops bad rows", () => {
    const parsed = parseExtractionResponse("```json\n" + JSON.stringify({
      characters: [{ name: "林砚", status: "已死", aliases: "砚哥、阿砚" }, { nope: true }],
      relationships: [{ from: "林砚", to: "周岚", type: "搭档", strength: 4 }, { from: "", to: "x", type: "y" }],
      dialogues: [{ speaker: "林砚", quote: "好。", addressee: "" }],
      events: "not-an-array",
    }) + "\n```");
    expect(parsed.characters).toEqual([{ name: "林砚", status: "dead", aliases: ["砚哥", "阿砚"] }]);
    expect(parsed.relationships).toHaveLength(1);
    expect(parsed.relationships[0]!.strength).toBeCloseTo(0.8);
    expect(parsed.relationships[0]!.status).toBe("active");
    expect(parsed.dialogues[0]!.addressee).toBeUndefined();
    expect(parsed.events).toEqual([]);
    expect(() => parseExtractionResponse("no json here")).toThrow(/no JSON/);
  });

  it("heuristic extractor attributes quotes and co-occurrence without a model", async () => {
    const extractor = new HeuristicChapterGraphExtractor();
    const out = await extractor.extract({
      chapterNumber: 3,
      title: "占位",
      content: FIXTURE_CHAPTERS[3]!.body,
      language: "zh",
      knownCharacters: roster().characters,
      summaryHint: "周岚和林砚对完账；缺口在韩铎手里",
    });
    expect(out.characters.map((c) => c.name)).toEqual(expect.arrayContaining(["林砚", "周岚", "韩铎"]));
    expect(out.dialogues).toEqual(expect.arrayContaining([
      expect.objectContaining({ speaker: "周岚", quote: "缺的那笔，在韩铎手里。" }),
      expect.objectContaining({ speaker: "林砚", quote: "我答应你，三天内拿回来。" }),
    ]));
    expect(out.events.length).toBe(2);
  });
});

describe("story-graph reconcile (truth files win)", () => {
  it("canonicalises aliases, overrides status, drops contradicting edges and unverifiable quotes", () => {
    const r3 = reconcileExtraction({ extraction: FIXTURE_EXTRACTIONS[3]!, roster: roster(), content: FIXTURE_CHAPTERS[3]!.body });
    expect(r3.extraction.characters.map((c) => c.name).sort()).toEqual(["周岚", "林砚", "韩铎"].sort());
    expect(r3.extraction.characters.find((c) => c.name === "周岚")!.aliases).toContain("岚姐");
    expect(r3.extraction.relationships.map((e) => `${e.from}-${e.to}-${e.type}`)).toEqual(["林砚-周岚-搭档"]);
    expect(r3.extraction.dialogues.map((d) => d.speaker)).toEqual(["周岚", "林砚"]);
    expect(r3.extraction.dialogues.every((d) => d.verified)).toBe(true);
    expect(r3.conflicts.map((c) => `${c.kind}:${c.resolution}`)).toEqual(expect.arrayContaining([
      "alias:renamed", "relationship:dropped", "dialogue:dropped",
    ]));

    const r5 = reconcileExtraction({ extraction: FIXTURE_EXTRACTIONS[5]!, roster: roster(), content: FIXTURE_CHAPTERS[5]!.body });
    expect(r5.extraction.characters.find((c) => c.name === "老秦")!.status).toBe("dead");
    expect(r5.conflicts).toEqual([expect.objectContaining({ kind: "status", resolution: "truth-wins", subject: "老秦" })]);
  });
});


