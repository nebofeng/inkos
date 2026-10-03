import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BookConfig } from "../models/book.js";
import type { ChapterMeta } from "../models/chapter.js";
import type { PlanChapterOutput } from "../agents/planner.js";
import { composeGovernedChapter } from "../agents/composer.js";
import { StateManager } from "../state/manager.js";
import { deleteLatestChapter } from "../state/chapter-delete.js";
import { DEFAULT_STORY_GRAPH_CONFIG } from "../story-graph/config.js";
import { runStoryGraphAfterChapter, storyGraphContextProviderFor } from "../story-graph/hooks.js";
import { listGraphChapters } from "../story-graph/journal.js";
import { backfillStoryGraph } from "../story-graph/service.js";
import { StoryGraphStore } from "../story-graph/store.js";
import { FIXTURE_EXTRACTIONS, FixtureExtractor, writeFixtureBook } from "./fixtures/story-graph-fixture.js";

const enabled = { ...DEFAULT_STORY_GRAPH_CONFIG, enabled: true };

function chapterEntry(number: number, title: string): ChapterMeta {
  const now = new Date().toISOString();
  return { number, title, status: "ready-for-review", wordCount: 10, createdAt: now, updatedAt: now, auditIssues: [], lengthWarnings: [] };
}

describe("story-graph pipeline hooks", () => {
  let root: string;
  let bookDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-graph-hooks-"));
    bookDir = join(root, "books", "b1");
    await writeFixtureBook(bookDir);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("(A) runStoryGraphAfterChapter", () => {
    it("does nothing (and builds no agent) when the flag is off", async () => {
      let built = false;
      await runStoryGraphAfterChapter({
        projectRoot: root, bookDir, chapterNumber: 1,
        completion: () => { built = true; throw new Error("must not be called"); },
        config: DEFAULT_STORY_GRAPH_CONFIG,
      });
      expect(built).toBe(false);
      expect(await listGraphChapters(bookDir)).toEqual([]);
    });

    it("extracts via the LLM completion when enabled", async () => {
      const prompts: string[] = [];
      const logs: string[] = [];
      await runStoryGraphAfterChapter({
        projectRoot: root, bookDir, chapterNumber: 1, config: enabled,
        completion: () => ({
          model: "test-model",
          complete: async (messages) => {
            prompts.push(messages.map((message) => message.content).join("\n"));
            return "```json\n" + JSON.stringify(FIXTURE_EXTRACTIONS[1]) + "\n```";
          },
        }),
        logger: { info: (message) => logs.push(message) },
      });
      expect(prompts[0]).toContain("林砚（阿砚、砚哥、小林）");
      expect(await listGraphChapters(bookDir)).toEqual([1]);
      expect(logs[0]).toMatch(/\[story-graph\] chapter 1: 2 characters, 1 relationships, 1 events, 2 dialogue lines/);
    });

    it("never throws into the pipeline when extraction fails", async () => {
      const warnings: string[] = [];
      await expect(runStoryGraphAfterChapter({
        projectRoot: root, bookDir, chapterNumber: 1, config: enabled,
        completion: () => ({ complete: async () => { throw new Error("502 Bad Gateway"); } }),
        logger: { warn: (message) => warnings.push(message) },
      })).resolves.toBeUndefined();
      expect(warnings[0]).toContain("502 Bad Gateway");
    });

    it("re-extracts a revised earlier chapter (bounded by refreshStaleLimit)", async () => {
      await backfillStoryGraph({ bookDir, extractor: new FixtureExtractor(), toChapter: 5 });
      const chapter2 = join(bookDir, "chapters", "0002_占位标题二.md");
      await writeFile(chapter2, `${await readFile(chapter2, "utf-8")}\n修订占位。\n`, "utf-8");
      const seen: number[] = [];
      await runStoryGraphAfterChapter({
        projectRoot: root, bookDir, chapterNumber: 6, config: enabled,
        completion: () => ({
          complete: async (messages) => {
            const chapter = Number(messages[1]!.content.match(/第(\d+)章/)![1]);
            seen.push(chapter);
            return JSON.stringify(FIXTURE_EXTRACTIONS[chapter]);
          },
        }),
      });
      expect(seen).toEqual([6, 2]);
    });

    it("uses the offline heuristic extractor without touching the model", async () => {
      await runStoryGraphAfterChapter({
        projectRoot: root, bookDir, chapterNumber: 3, config: { ...enabled, extractor: "heuristic" },
        completion: () => { throw new Error("must not be called"); },
      });
      expect(await listGraphChapters(bookDir)).toEqual([3]);
    });
  });

  describe("(B) composer provider", () => {
    const book: BookConfig = {
      id: "b1", title: "B1", platform: "tomato", genre: "xuanhuan", status: "active",
      targetChapters: 20, chapterWordCount: 3000,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const plan = (storyDir: string): PlanChapterOutput => ({
      intent: {
        chapter: 7, goal: "岚姐追问铜钥匙的来历", outlineNode: "码头旧账", mustKeep: [], mustAvoid: [], styleEmphasis: [],
      },
      memo: { chapter: 7, goal: "岚姐追问铜钥匙的来历", isGoldenOpening: false, body: "", threadRefs: [] },
      intentMarkdown: "# Chapter Intent\n",
      plannerInputs: [],
      runtimePath: join(storyDir, "runtime", "chapter-0007.intent.md"),
    });

    it("returns no provider when the flag is off", () => {
      expect(storyGraphContextProviderFor({ projectRoot: root, bookDir, config: DEFAULT_STORY_GRAPH_CONFIG })).toBeUndefined();
    });

    it("appends graph entries after BM25 memory and records a trace note", async () => {
      await backfillStoryGraph({ bookDir, extractor: new FixtureExtractor() });
      const storyDir = join(bookDir, "story");
      await mkdir(join(storyDir, "runtime"), { recursive: true });
      await writeFile(join(storyDir, "current_state.md"), "# 当前状态\n\n- 林砚手里有铜钥匙\n", "utf-8");

      const withGraph = await composeGovernedChapter({
        book, bookDir, chapterNumber: 7, plan: plan(storyDir),
        storyGraphContextProvider: storyGraphContextProviderFor({ projectRoot: root, bookDir, config: enabled }),
      });
      const sources = withGraph.contextPackage.selectedContext.map((entry) => entry.source);
      expect(sources).toEqual(expect.arrayContaining(["story/graph#characters", "story/graph#dialogue"]));
      expect(sources.indexOf("story/graph#characters")).toBeGreaterThan(sources.indexOf("story/current_state.md"));
      expect(withGraph.trace.notes?.some((note) => note.startsWith("story-graph:ok:seeds="))).toBe(true);

      const without = await composeGovernedChapter({ book, bookDir, chapterNumber: 7, plan: plan(storyDir) });
      expect(without.contextPackage.selectedContext.some((entry) => entry.source.startsWith("story/graph#"))).toBe(false);
    });

    it("degrades to no graph context if the provider fails", async () => {
      const result = await composeGovernedChapter({
        book, bookDir, chapterNumber: 7, plan: plan(join(bookDir, "story")),
        storyGraphContextProvider: async () => { throw new Error("boom"); },
      });
      expect(result.contextPackage.selectedContext.some((entry) => entry.source.startsWith("story/graph#"))).toBe(false);
      expect(result.trace.notes).toContain("story-graph-unavailable");
    });
  });

  describe("(C) rollback / chapter delete", () => {
    it("deleting the latest chapter drops its graph journal and rows", async () => {
      await writeFile(join(bookDir, "book.json"), JSON.stringify({ id: "b1", title: "b1" }), "utf-8");
      await writeFile(join(bookDir, "chapters", "index.json"), JSON.stringify(
        [1, 2, 3, 4, 5, 6].map((n) => chapterEntry(n, `占位${n}`)),
      ), "utf-8");
      for (const n of [5, 6]) {
        const dir = join(bookDir, "story", "snapshots", String(n));
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "current_state.md"), `state ${n}`, "utf-8");
        await writeFile(join(dir, "pending_hooks.md"), `hooks ${n}`, "utf-8");
      }
      await backfillStoryGraph({ bookDir, extractor: new FixtureExtractor() });
      const result = await deleteLatestChapter(new StateManager(root), "b1");
      expect(result.deletedChapter).toBe(6);
      expect(await listGraphChapters(bookDir)).toEqual([1, 2, 3, 4, 5]);
      const store = new StoryGraphStore(bookDir);
      try {
        expect([...store.projectedHashes().keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
      } finally {
        store.close();
      }
    });

    it("rollback without a graph journal leaves no graph artefacts", async () => {
      await writeFile(join(bookDir, "book.json"), JSON.stringify({ id: "b1", title: "b1" }), "utf-8");
      await writeFile(join(bookDir, "chapters", "index.json"), JSON.stringify([chapterEntry(1, "a"), chapterEntry(2, "b")]), "utf-8");
      const dir = join(bookDir, "story", "snapshots", "1");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "current_state.md"), "s", "utf-8");
      await writeFile(join(dir, "pending_hooks.md"), "h", "utf-8");
      await new StateManager(root).rollbackToChapter("b1", 1);
      await expect(access(join(bookDir, "story", "graph"))).rejects.toThrow();
    });
  });
});
