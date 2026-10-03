import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cosine, createEmbedderFromConfig, fuseRankings, OpenAICompatibleEmbedder, semanticSearch } from "../story-graph/vector.js";
import { resolveStoryGraphConfig } from "../story-graph/config.js";
import { retrieveStoryGraphContext } from "../story-graph/retrieval.js";
import { backfillStoryGraph } from "../story-graph/service.js";
import type { StoryGraphEmbedder } from "../story-graph/types.js";
import { FixtureExtractor, writeFixtureBook } from "./fixtures/story-graph-fixture.js";

/** Toy "semantic" embedder: concept buckets, so 保证 ≈ 答应 without shared characters. */
class ConceptEmbedder implements StoryGraphEmbedder {
  readonly id = "mock:concepts";
  readonly dimensions = 3;
  calls = 0;
  private readonly buckets = [/答应|保证|承诺|发誓/, /钱|债|还清/, /钥匙|锁/];
  async embed(texts: ReadonlyArray<string>) {
    this.calls += 1;
    return texts.map((text) => this.buckets.map((bucket) => (bucket.test(text) ? 1 : 0.01)));
  }
}

describe("story-graph vector retrieval (optional)", () => {
  let root: string;
  let bookDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-graph-vector-"));
    bookDir = join(root, "books", "b1");
    await writeFixtureBook(bookDir);
    await backfillStoryGraph({ bookDir, extractor: new FixtureExtractor() });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("cosine + reciprocal-rank fusion basics", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(fuseRankings([["a", "b", "c"], ["c", "a"]])[0]).toBe("a");
  });

  it("is off by default and configurable via inkos.json memory.graph.vector", async () => {
    expect(resolveStoryGraphConfig(undefined, {}).vector.enabled).toBe(false);
    expect(createEmbedderFromConfig(resolveStoryGraphConfig(undefined, {}).vector)).toBeUndefined();
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      memory: { graph: { vector: { enabled: true, baseUrl: "http://emb.local/v1", model: "m", apiKeyEnv: "EMB_KEY" } } },
    }), "utf-8");
    const config = resolveStoryGraphConfig(root, {});
    expect(config.vector).toEqual({ enabled: true, baseUrl: "http://emb.local/v1", model: "m", apiKeyEnv: "EMB_KEY" });
    expect(createEmbedderFromConfig(config.vector, { EMB_KEY: "k" })?.id).toBe("openai-compatible:m");
  });

  it("OpenAI-compatible embedder posts to /embeddings and orders rows by index", async () => {
    const seen: Array<{ url: string; body: string; auth?: string }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: String(init.body), auth: (init.headers as Record<string, string>).authorization });
      return new Response(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const embedder = new OpenAICompatibleEmbedder({ baseUrl: "http://emb.local/v1/", model: "m", apiKey: "k" }, fakeFetch);
    expect(await embedder.embed(["a", "b"])).toEqual([[1, 0], [0, 1]]);
    expect(seen[0]).toMatchObject({ url: "http://emb.local/v1/embeddings", auth: "Bearer k" });
    expect(JSON.parse(seen[0]!.body)).toEqual({ model: "m", input: ["a", "b"] });
  });

  it("caches vectors in memory.db and only embeds new/changed docs", async () => {
    const embedder = new ConceptEmbedder();
    const docs = [
      { id: "x1", chapter: 1, text: "我答应你" },
      { id: "x2", chapter: 2, text: "欠的钱" },
      { id: "x3", chapter: 9, text: "我保证" },
    ];
    const first = await semanticSearch({ bookDir, embedder, documents: docs, query: "他发誓", before: 5 });
    expect(first[0]).toBe("x1");
    expect(first).not.toContain("x3"); // chapter >= before is never returned
    const callsAfterFirst = embedder.calls;
    await semanticSearch({ bookDir, embedder, documents: docs, query: "他发誓", before: 5 });
    expect(embedder.calls).toBe(callsAfterFirst + 1); // only the query was embedded
  });

  it("surfaces a paraphrased promise BM25 cannot match", async () => {
    const goal = "兑现保证"; // no name, no lexical overlap with the quote
    const lexical = await retrieveStoryGraphContext({ bookDir, chapterNumber: 7, goal, config: { maxDialogues: 1 } });
    const semantic = await retrieveStoryGraphContext({ bookDir, chapterNumber: 7, goal, config: { maxDialogues: 1 }, embedder: new ConceptEmbedder() });
    const dialogue = (ctx: typeof lexical) => ctx.entries.find((entry) => entry.source === "story/graph#dialogue")?.excerpt ?? "";
    expect(dialogue(lexical)).not.toContain("我答应你");
    expect(dialogue(semantic)).toContain("我答应你，三天内拿回来。");
    expect(semantic.trace.note).toContain("vector:mock:concepts");
  });

  it("falls back to BM25 when the embedder fails", async () => {
    const broken: StoryGraphEmbedder = { id: "broken", dimensions: 0, embed: async () => { throw new Error("HTTP 404"); } };
    const context = await retrieveStoryGraphContext({ bookDir, chapterNumber: 7, goal: "林砚", embedder: broken });
    expect(context.entries.length).toBeGreaterThan(0);
    expect(context.trace.note).toContain("vector-unavailable:HTTP 404");
  });
});
