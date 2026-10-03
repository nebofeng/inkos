/**
 * Story-graph indexing service: extract → reconcile → journal → project.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalSearchIndex, type SearchDocument } from "../retrieval/local-search.js";
import { parseChapterSummariesMarkdown } from "../utils/story-markdown.js";
import {
  hashChapterContent,
  listGraphChapters,
  pruneGraphJournalAfter,
  readAllGraphRecords,
  readGraphRecord,
  writeGraphRecord,
} from "./journal.js";
import { buildResolver, reconcileExtraction } from "./reconcile.js";
import { StoryGraphStore } from "./store.js";
import { loadTruthRoster, type TruthRoster } from "./truth.js";
import type { ChapterGraphExtractor, ChapterGraphRecord } from "./types.js";

export const STORY_GRAPH_SEARCH_SCOPE = "story-graph";

export interface ChapterFile {
  readonly chapter: number;
  readonly fileName: string;
  readonly title: string;
  readonly content: string;
  readonly contentHash: string;
}

export async function listChapterFiles(bookDir: string): Promise<Array<{ chapter: number; fileName: string }>> {
  try {
    return (await readdir(join(bookDir, "chapters")))
      .map((fileName) => ({ fileName, match: fileName.match(/^(\d+)[_-]?.*\.md$/) }))
      .filter((entry): entry is { fileName: string; match: RegExpMatchArray } => entry.match !== null)
      .map((entry) => ({ chapter: parseInt(entry.match[1]!, 10), fileName: entry.fileName }))
      .sort((a, b) => a.chapter - b.chapter);
  } catch {
    return [];
  }
}

export async function readChapterFile(bookDir: string, chapter: number): Promise<ChapterFile | null> {
  const entry = (await listChapterFiles(bookDir)).find((file) => file.chapter === chapter);
  if (!entry) return null;
  const raw = await readFile(join(bookDir, "chapters", entry.fileName), "utf-8");
  const lines = raw.split("\n");
  const heading = lines[0]?.startsWith("#") ? lines[0].replace(/^#+\s*/, "").trim() : "";
  const contentStart = heading ? lines.findIndex((line, index) => index > 0 && line.trim().length > 0) : 0;
  const content = contentStart >= 0 ? lines.slice(contentStart).join("\n") : raw;
  const title = heading.replace(/^第\s*\d+\s*章\s*/, "").trim()
    || entry.fileName.replace(/^\d+[_-]?/, "").replace(/\.md$/, "");
  return { chapter, fileName: entry.fileName, title, content, contentHash: hashChapterContent(content) };
}

async function readSummaryHint(bookDir: string, chapter: number): Promise<string | undefined> {
  const markdown = await readFile(join(bookDir, "story", "chapter_summaries.md"), "utf-8").catch(() => "");
  const row = parseChapterSummariesMarkdown(markdown).find((summary) => summary.chapter === chapter);
  if (!row) return undefined;
  return [row.events, row.stateChanges].filter(Boolean).join("；") || undefined;
}

export interface ExtractChapterResult {
  readonly record: ChapterGraphRecord;
  readonly skipped: boolean;
}

/**
 * Extract one chapter into the graph (journal + projection). Idempotent: an
 * unchanged chapter already extracted by the same extractor is skipped unless
 * `force` is set.
 */
export async function extractChapterToGraph(params: {
  readonly bookDir: string;
  readonly chapter: number;
  readonly extractor: ChapterGraphExtractor;
  readonly language?: "zh" | "en";
  readonly force?: boolean;
  readonly roster?: TruthRoster;
}): Promise<ExtractChapterResult> {
  const file = await readChapterFile(params.bookDir, params.chapter);
  if (!file) throw new Error(`story-graph: chapter ${params.chapter} file not found`);
  const existing = await readGraphRecord(params.bookDir, params.chapter);
  if (!params.force && existing && existing.contentHash === file.contentHash && extractorFamily(existing.extractor) === extractorFamily(params.extractor.id)) {
    return { record: existing, skipped: true };
  }
  const roster = params.roster ?? await loadTruthRoster(params.bookDir);
  const learned = await learnedAliases(params.bookDir, params.chapter);
  const resolver = buildResolver(roster, learned);
  const knownCharacters = [
    ...roster.characters.map((entry) => ({ name: entry.name, aliases: entry.aliases })),
    ...learned.filter((entry) => !roster.characters.some((truth) => truth.name === entry.name)),
  ];
  const raw = await params.extractor.extract({
    chapterNumber: params.chapter,
    title: file.title,
    content: file.content,
    language: params.language ?? "zh",
    knownCharacters,
    summaryHint: await readSummaryHint(params.bookDir, params.chapter),
  });
  const reconciled = reconcileExtraction({ extraction: raw, roster, content: file.content, resolver });
  const record: ChapterGraphRecord = {
    version: 1,
    chapter: params.chapter,
    title: file.title,
    contentHash: file.contentHash,
    extractor: params.extractor.id,
    extractedAt: new Date().toISOString(),
    extraction: reconciled.extraction,
    conflicts: reconciled.conflicts,
  };
  await writeGraphRecord(params.bookDir, record);
  const store = new StoryGraphStore(params.bookDir);
  try {
    store.replaceChapter(record);
  } finally {
    store.close();
  }
  await refreshGraphSearchIndex(params.bookDir);
  return { record, skipped: false };
}

/** Aliases learned from earlier chapters' extractions (truth roster still wins). */
async function learnedAliases(bookDir: string, beforeChapter: number): Promise<Array<{ name: string; aliases: string[] }>> {
  const byName = new Map<string, Set<string>>();
  for (const record of await readAllGraphRecords(bookDir)) {
    if (record.chapter >= beforeChapter) continue;
    for (const character of record.extraction.characters) {
      const set = byName.get(character.name) ?? new Set<string>();
      for (const alias of character.aliases ?? []) set.add(alias);
      byName.set(character.name, set);
    }
  }
  return [...byName.entries()].map(([name, aliases]) => ({ name, aliases: [...aliases] }));
}

/**
 * Bring the memory.db projection in line with the journal. Cheap when nothing
 * changed; rebuilds everything after memory.db was dropped by a rollback.
 * Journal entries beyond `maxChapter` (e.g. a crashed rollback) are ignored.
 */
export async function syncStoryGraph(bookDir: string, options: { readonly maxChapter?: number } = {}): Promise<{
  readonly replaced: number[];
  readonly removed: number[];
}> {
  const records = (await readAllGraphRecords(bookDir))
    .filter((record) => options.maxChapter === undefined || record.chapter <= options.maxChapter);
  const store = new StoryGraphStore(bookDir);
  let result: { replaced: number[]; removed: number[] };
  try {
    result = store.syncFromRecords(records);
  } finally {
    store.close();
  }
  if (result.replaced.length > 0 || result.removed.length > 0) {
    await refreshGraphSearchIndex(bookDir, records);
  }
  return result;
}

/** BM25 documents for graph dialogue/events, in the shared retrieval kernel. */
export async function refreshGraphSearchIndex(bookDir: string, records?: ReadonlyArray<ChapterGraphRecord>): Promise<void> {
  const all = records ?? await readAllGraphRecords(bookDir);
  const documents: SearchDocument[] = [];
  for (const record of all) {
    record.extraction.dialogues.forEach((dialogue, seq) => {
      documents.push({
        id: `graph-dialogue:${record.chapter}:${seq}`,
        scope: STORY_GRAPH_SEARCH_SCOPE,
        kind: "graph-dialogue",
        source: `story/graph/chapter-${String(record.chapter).padStart(4, "0")}.json#dialogue-${seq}`,
        title: [dialogue.speaker, dialogue.addressee].filter(Boolean).join(" → "),
        body: [dialogue.quote, dialogue.context].filter(Boolean).join("\n"),
        metadata: { chapter: record.chapter, seq },
      });
    });
    record.extraction.events.forEach((event, seq) => {
      documents.push({
        id: `graph-event:${record.chapter}:${seq}`,
        scope: STORY_GRAPH_SEARCH_SCOPE,
        kind: "graph-event",
        source: `story/graph/chapter-${String(record.chapter).padStart(4, "0")}.json#event-${seq}`,
        title: (event.participants ?? []).join(" "),
        body: [event.summary, event.location].filter(Boolean).join("\n"),
        metadata: { chapter: record.chapter, seq },
      });
    });
  }
  const index = new LocalSearchIndex(join(bookDir, "story", "memory.db"));
  try {
    index.replaceScope(STORY_GRAPH_SEARCH_SCOPE, documents);
  } finally {
    index.close();
  }
}

/** Rollback / chapter-delete cleanup: journal + projection for chapters > target. */
export async function pruneStoryGraphAfter(bookDir: string, targetChapter: number): Promise<number[]> {
  const removed = await pruneGraphJournalAfter(bookDir, targetChapter);
  // memory.db may already be gone (rollback deletes it); sync recreates cleanly.
  await syncStoryGraph(bookDir, { maxChapter: targetChapter });
  return removed;
}

export interface StoryGraphStatus {
  readonly chapterFiles: number;
  readonly extracted: number[];
  readonly missing: number[];
  /** Extracted, but the chapter text changed since (e.g. revised). */
  readonly stale: number[];
  readonly stats: Record<string, number>;
}

export async function getStoryGraphStatus(bookDir: string): Promise<StoryGraphStatus> {
  await syncStoryGraph(bookDir);
  const files = await listChapterFiles(bookDir);
  const extracted = await listGraphChapters(bookDir);
  const extractedSet = new Set(extracted);
  const stale: number[] = [];
  for (const chapter of extracted) {
    const [file, record] = await Promise.all([readChapterFile(bookDir, chapter), readGraphRecord(bookDir, chapter)]);
    if (file && record && file.contentHash !== record.contentHash) stale.push(chapter);
  }
  const store = new StoryGraphStore(bookDir);
  try {
    return {
      chapterFiles: files.length,
      extracted,
      missing: files.map((file) => file.chapter).filter((chapter) => !extractedSet.has(chapter)),
      stale,
      stats: store.stats(),
    };
  } finally {
    store.close();
  }
}

export interface BackfillProgress {
  readonly chapter: number;
  readonly index: number;
  readonly total: number;
  readonly status: "extracted" | "skipped" | "failed";
  readonly error?: string;
}

/** Sequential (load-friendly) batch extraction for already-written chapters. */
export async function backfillStoryGraph(params: {
  readonly bookDir: string;
  readonly extractor: ChapterGraphExtractor;
  readonly language?: "zh" | "en";
  readonly fromChapter?: number;
  readonly toChapter?: number;
  readonly force?: boolean;
  /** Only (re)extract chapters that are missing or stale. Default true. */
  readonly onlyMissingOrStale?: boolean;
  readonly onProgress?: (progress: BackfillProgress) => void;
}): Promise<{ readonly extracted: number[]; readonly skipped: number[]; readonly failed: Array<{ chapter: number; error: string }> }> {
  const chapters = (await listChapterFiles(params.bookDir))
    .map((file) => file.chapter)
    .filter((chapter) => chapter >= (params.fromChapter ?? 1) && chapter <= (params.toChapter ?? Number.MAX_SAFE_INTEGER));
  const roster = await loadTruthRoster(params.bookDir);
  const extracted: number[] = [];
  const skipped: number[] = [];
  const failed: Array<{ chapter: number; error: string }> = [];
  for (const [index, chapter] of chapters.entries()) {
    try {
      if (!params.force && params.onlyMissingOrStale !== false) {
        const [record, file] = await Promise.all([readGraphRecord(params.bookDir, chapter), readChapterFile(params.bookDir, chapter)]);
        if (record && file && record.contentHash === file.contentHash && extractorFamily(record.extractor) === extractorFamily(params.extractor.id)) {
          skipped.push(chapter);
          params.onProgress?.({ chapter, index, total: chapters.length, status: "skipped" });
          continue;
        }
      }
      const result = await extractChapterToGraph({
        bookDir: params.bookDir,
        chapter,
        extractor: params.extractor,
        language: params.language,
        force: params.force,
        roster,
      });
      (result.skipped ? skipped : extracted).push(chapter);
      params.onProgress?.({ chapter, index, total: chapters.length, status: result.skipped ? "skipped" : "extracted" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ chapter, error: message });
      params.onProgress?.({ chapter, index, total: chapters.length, status: "failed", error: message });
    }
  }
  return { extracted, skipped, failed };
}

/** Chapters < `beforeChapter` whose text changed since extraction. */
export async function findStaleGraphChapters(bookDir: string, beforeChapter: number): Promise<number[]> {
  const stale: number[] = [];
  for (const chapter of await listGraphChapters(bookDir)) {
    if (chapter >= beforeChapter) continue;
    const [file, record] = await Promise.all([readChapterFile(bookDir, chapter), readGraphRecord(bookDir, chapter)]);
    if (file && record && file.contentHash !== record.contentHash) stale.push(chapter);
  }
  return stale;
}

/** "llm:model:v1" → "llm"; switching heuristic → llm re-extracts, a model change does not. */
function extractorFamily(id: string): string {
  return id.split(":")[0] ?? id;
}
