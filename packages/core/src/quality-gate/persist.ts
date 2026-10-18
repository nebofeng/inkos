import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { QualityGateOnFail } from "../models/project.js";

export interface QualityGateChapterRecord {
  readonly chapterNumber: number;
  readonly passed: boolean;
  readonly score: number;
  readonly wordCount: number;
  readonly minWords: number;
  readonly aiFlavorThreshold: number;
  readonly reasons: readonly string[];
  readonly onFail: QualityGateOnFail;
  readonly attempts: number;
  readonly skipped?: boolean;
  readonly evaluatedAt: string;
}

export interface QualityGateFile {
  readonly bookId: string;
  readonly updatedAt: string;
  readonly chapters: QualityGateChapterRecord[];
}

export function qualityGateJsonPath(bookDir: string): string {
  return join(bookDir, "story", "quality-gate.json");
}

export async function readQualityGateFile(bookDir: string): Promise<QualityGateFile | undefined> {
  try {
    const raw = await readFile(qualityGateJsonPath(bookDir), "utf-8");
    const parsed = JSON.parse(raw) as QualityGateFile;
    if (!parsed || !Array.isArray(parsed.chapters)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export async function appendQualityGateRecord(
  bookDir: string,
  bookId: string,
  record: QualityGateChapterRecord,
): Promise<string> {
  const path = qualityGateJsonPath(bookDir);
  const existing = await readQualityGateFile(bookDir);
  const chapters = (existing?.chapters ?? []).filter((entry) => entry.chapterNumber !== record.chapterNumber);
  chapters.push(record);
  chapters.sort((a, b) => a.chapterNumber - b.chapterNumber);
  const payload: QualityGateFile = {
    bookId,
    updatedAt: record.evaluatedAt,
    chapters,
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return path;
}
