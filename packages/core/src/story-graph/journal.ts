/**
 * Authoritative per-chapter journal: story/graph/chapter-NNNN.json.
 *
 * memory.db is deleted wholesale on rollback (StateManager.rollbackToChapter),
 * so the graph tables are only a projection of these files and are rebuilt
 * from them on demand (no LLM call needed).
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChapterGraphRecord } from "./types.js";

export function graphJournalDir(bookDir: string): string {
  return join(bookDir, "story", "graph");
}

export function graphJournalPath(bookDir: string, chapter: number): string {
  return join(graphJournalDir(bookDir), `chapter-${String(chapter).padStart(4, "0")}.json`);
}

export function hashChapterContent(content: string): string {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n").trim()).digest("hex").slice(0, 16);
}

export function hashRecord(record: ChapterGraphRecord): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex").slice(0, 16);
}

export async function writeGraphRecord(bookDir: string, record: ChapterGraphRecord): Promise<void> {
  await mkdir(graphJournalDir(bookDir), { recursive: true });
  const path = graphJournalPath(bookDir, record.chapter);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  await rename(tmp, path);
}

export async function readGraphRecord(bookDir: string, chapter: number): Promise<ChapterGraphRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(graphJournalPath(bookDir, chapter), "utf-8")) as ChapterGraphRecord;
    return parsed && parsed.version === 1 && parsed.chapter === chapter ? parsed : null;
  } catch {
    return null;
  }
}

export async function listGraphChapters(bookDir: string): Promise<number[]> {
  try {
    return (await readdir(graphJournalDir(bookDir)))
      .map((file) => file.match(/^chapter-(\d+)\.json$/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => parseInt(match[1]!, 10))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export async function readAllGraphRecords(bookDir: string): Promise<ChapterGraphRecord[]> {
  const chapters = await listGraphChapters(bookDir);
  const records = await Promise.all(chapters.map((chapter) => readGraphRecord(bookDir, chapter)));
  return records.filter((record): record is ChapterGraphRecord => record !== null);
}

/** Remove journal entries for chapters > targetChapter. Returns removed chapters. */
export async function pruneGraphJournalAfter(bookDir: string, targetChapter: number): Promise<number[]> {
  const removed: number[] = [];
  for (const chapter of await listGraphChapters(bookDir)) {
    if (chapter > targetChapter) {
      await rm(graphJournalPath(bookDir, chapter), { force: true });
      removed.push(chapter);
    }
  }
  return removed;
}

export async function removeGraphRecord(bookDir: string, chapter: number): Promise<void> {
  await rm(graphJournalPath(bookDir, chapter), { force: true });
}
