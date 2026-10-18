import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DeAIChapterRecord, DeAIFile } from "./types.js";

const DEFAULT_RELATIVE_PATH = join("story", "deai.json");

export function deAIJsonPath(bookDir: string, relativePath = DEFAULT_RELATIVE_PATH): string {
  return join(bookDir, relativePath);
}

export async function readDeAIFile(bookDir: string, relativePath = DEFAULT_RELATIVE_PATH): Promise<DeAIFile | undefined> {
  try {
    const raw = await readFile(deAIJsonPath(bookDir, relativePath), "utf-8");
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
  relativePath = DEFAULT_RELATIVE_PATH,
): Promise<string> {
  const path = deAIJsonPath(bookDir, relativePath);
  const existing = await readDeAIFile(bookDir, relativePath);
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
