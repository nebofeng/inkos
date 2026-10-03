import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoryGraphStore } from "../story-graph/store.js";
import { graphJournalPath, listGraphChapters } from "../story-graph/journal.js";
import {
  backfillStoryGraph,
  extractChapterToGraph,
  getStoryGraphStatus,
  pruneStoryGraphAfter,
  syncStoryGraph,
} from "../story-graph/service.js";
import { pruneStoryGraphOnRollback } from "../story-graph/hooks.js";
import { FixtureExtractor, writeFixtureBook } from "./fixtures/story-graph-fixture.js";

describe("story-graph store + journal", () => {
  let root: string;
  let bookDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-graph-store-"));
    bookDir = join(root, "books", "b1");
    await writeFixtureBook(bookDir);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes the journal and projects into memory.db graph_* tables", async () => {
    const extractor = new FixtureExtractor();
    const result = await extractChapterToGraph({ bookDir, chapter: 3, extractor });
    expect(result.skipped).toBe(false);
    const journal = JSON.parse(await readFile(graphJournalPath(bookDir, 3), "utf-8"));
    expect(journal).toMatchObject({ version: 1, chapter: 3, extractor: "mock:fixture", title: "占位标题三" });
    expect(journal.conflicts.length).toBeGreaterThanOrEqual(3);

    const store = new StoryGraphStore(bookDir);
    try {
      expect(store.stats()).toMatchObject({ chapters: 1, edges: 1, dialogues: 2, events: 1 });
      const snapshot = store.snapshot(4);
      expect(snapshot.events[0]!.participants.sort()).toEqual(["周岚", "林砚", "韩铎"].sort());
      expect(store.snapshot(3).entities).toEqual([]);
    } finally {
      store.close();
    }

    // Idempotent: unchanged chapter is skipped (no second model call).
    const again = await extractChapterToGraph({ bookDir, chapter: 3, extractor });
    expect(again.skipped).toBe(true);
    expect(extractor.calls).toEqual([3]);
  });

  it("rebuilds the projection from the journal after memory.db is deleted (rollback path)", async () => {
    await backfillStoryGraph({ bookDir, extractor: new FixtureExtractor() });
    for (const suffix of ["", "-shm", "-wal"]) await rm(join(bookDir, "story", `memory.db${suffix}`), { force: true });
    const synced = await syncStoryGraph(bookDir);
    expect(synced.replaced).toEqual([1, 2, 3, 4, 5, 6]);
    const store = new StoryGraphStore(bookDir);
    try {
      expect(store.stats().chapters).toBe(6);
    } finally {
      store.close();
    }
    expect((await syncStoryGraph(bookDir)).replaced).toEqual([]);
  });

  it("prunes chapters after a rollback target (journal + rows)", async () => {
    await backfillStoryGraph({ bookDir, extractor: new FixtureExtractor() });
    const removed = await pruneStoryGraphAfter(bookDir, 4);
    expect(removed).toEqual([5, 6]);
    expect(await listGraphChapters(bookDir)).toEqual([1, 2, 3, 4]);
    const store = new StoryGraphStore(bookDir);
    try {
      expect([...store.projectedHashes().keys()].sort()).toEqual([1, 2, 3, 4]);
      expect(store.snapshot(99).events.some((event) => event.chapter > 4)).toBe(false);
    } finally {
      store.close();
    }
  });

  it("rollback hook is a no-op without a journal and does not create memory.db", async () => {
    await pruneStoryGraphOnRollback(bookDir, 2);
    await expect(access(join(bookDir, "story", "memory.db"))).rejects.toThrow();
  });

  it("reports missing/stale chapters; backfill re-extracts only those (or all with force)", async () => {
    const extractor = new FixtureExtractor();
    await backfillStoryGraph({ bookDir, extractor, toChapter: 4 });
    expect(extractor.calls).toEqual([1, 2, 3, 4]);

    // Revise chapter 2's text → stale.
    const chapter2 = join(bookDir, "chapters", "0002_占位标题二.md");
    await writeFile(chapter2, `${await readFile(chapter2, "utf-8")}\n补一句占位。\n`, "utf-8");
    const status = await getStoryGraphStatus(bookDir);
    expect(status).toMatchObject({ chapterFiles: 6, extracted: [1, 2, 3, 4], missing: [5, 6], stale: [2] });

    const progress: string[] = [];
    const result = await backfillStoryGraph({ bookDir, extractor, onProgress: (p) => progress.push(`${p.chapter}:${p.status}`) });
    expect(result.extracted).toEqual([2, 5, 6]);
    expect(result.skipped).toEqual([1, 3, 4]);
    expect(progress).toHaveLength(6);

    const forced = await backfillStoryGraph({ bookDir, extractor, force: true, fromChapter: 5, toChapter: 5 });
    expect(forced.extracted).toEqual([5]);
  });

  it("records failures per chapter without aborting the batch", async () => {
    const failing = new FixtureExtractor();
    const original = failing.extract.bind(failing);
    failing.extract = async (input) => {
      if (input.chapterNumber === 2) throw new Error("gateway 502");
      return original(input);
    };
    const result = await backfillStoryGraph({ bookDir, extractor: failing, toChapter: 3 });
    expect(result.extracted).toEqual([1, 3]);
    expect(result.failed).toEqual([{ chapter: 2, error: "gateway 502" }]);
  });
});
