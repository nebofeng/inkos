import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DeAIChapterRecord, DeAIFile } from "./types.js";

export function deAIJsonPath(bookDir: string): string {
  return join(bookDir, "story", "deai.json");
}

export async function readDeAIFile(bookDir: string): Promise<DeAIFile | undefined> {
  try {
    const raw = await readFile(deAIJsonPath(bookDir), "utf-8");
    const parsed = JSON.parse(raw) as DeAIFile;
    if (!parsed || !Array.isArray(parsed.chapters)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export async function appendDeAIRecord(
  bookDir: string,
  bookId: string,
  record: DeAIChapterRecord,
): Promise<string> {
  const path = deAIJsonPath(bookDir);
  const existing = await readDeAIFile(bookDir);
  const chapters = (existing?.chapters ?? []).filter((entry) => entry.chapterNumber !== record.chapterNumber);
  chapters.push(record);
  chapters.sort((a, b) => a.chapterNumber - b.chapterNumber);
  const payload: DeAIFile = {
    bookId,
    updatedAt: record.evaluatedAt,
    chapters,
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return path;
}
