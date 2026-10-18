import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const PRE_DESLOP_MARK = ".pre-deslop";

/** Canonical chapter markdown: `NNNN_title.md`, never a deslop sidecar. */
export function isCanonicalChapterMarkdownFile(file: string): boolean {
  if (file.includes(PRE_DESLOP_MARK)) return false;
  return /^\d+[_-].*\.md$/.test(file);
}

export function preDeslopSidecarName(canonicalFile: string): string {
  return `${canonicalFile}${PRE_DESLOP_MARK}`;
}

export function paddedChapterPrefix(chapterNumber: number): string {
  return String(chapterNumber).padStart(4, "0");
}

export function findCanonicalChapterFile(
  files: ReadonlyArray<string>,
  chapterNumber: number,
): string | undefined {
  const padded = paddedChapterPrefix(chapterNumber);
  const paddedHit = files.find(
    (file) => file.startsWith(`${padded}_`) && isCanonicalChapterMarkdownFile(file),
  );
  if (paddedHit) return paddedHit;
  const unpadded = `${chapterNumber}_`;
  return files.find(
    (file) => file.startsWith(unpadded) && isCanonicalChapterMarkdownFile(file),
  );
}

export function stripChapterHeading(raw: string): string {
  const lines = raw.split("\n");
  const contentStart = lines.findIndex((line, index) => index > 0 && line.trim().length > 0);
  return contentStart >= 0 ? lines.slice(contentStart).join("\n") : raw;
}

export function replaceChapterBody(raw: string, body: string): string {
  const lines = raw.split("\n");
  const heading = lines[0] ?? "";
  return `${heading}\n\n${body.replace(/^\n+/, "")}`;
}

export async function resolveChapterMarkdownPath(
  bookDir: string,
  chapterNumber: number,
): Promise<{ readonly fileName: string; readonly filePath: string } | undefined> {
  const chaptersDir = join(bookDir, "chapters");
  const files = await readdir(chaptersDir).catch(() => [] as string[]);
  const fileName = findCanonicalChapterFile(files, chapterNumber);
  if (!fileName) return undefined;
  return { fileName, filePath: join(chaptersDir, fileName) };
}

export async function readChapterMarkdown(
  bookDir: string,
  chapterNumber: number,
): Promise<{ readonly fileName: string; readonly filePath: string; readonly raw: string; readonly body: string }> {
  const resolved = await resolveChapterMarkdownPath(bookDir, chapterNumber);
  if (!resolved) {
    throw new Error(`Chapter ${chapterNumber} file not found in ${join(bookDir, "chapters")}`);
  }
  const raw = await readFile(resolved.filePath, "utf-8");
  return {
    ...resolved,
    raw,
    body: stripChapterHeading(raw),
  };
}
