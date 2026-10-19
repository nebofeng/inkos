import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ANNOTATION_PREFIX_LEN,
  ANNOTATION_SUFFIX_LEN,
  type AnnotationOrigin,
  type AnnotationStatus,
  type TextQuotePositionSelector,
  relocateSelector,
} from "./annotation-anchors.js";

export interface NoteSuggestion {
  readonly targetText: string;
  readonly replacementText: string;
  readonly start: number;
  readonly end: number;
}

export interface ChapterNote {
  readonly id: string;
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly baseHash: string;
  readonly selector: TextQuotePositionSelector;
  readonly comment: string;
  readonly origin: AnnotationOrigin;
  readonly status: AnnotationStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly suggestion?: NoteSuggestion;
}

export interface ChapterAnnotationFile {
  readonly version: 1;
  readonly chapterNumber: number;
  readonly chapterId: string;
  readonly notes: ChapterNote[];
}

export function annotationsPath(bookDir: string, chapterNumber: number): string {
  assertChapterNumber(chapterNumber);
  return join(bookDir, "story", "runtime", `chapter-${padChapter(chapterNumber)}.annotations.json`);
}

export function sha256Source(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export async function readChapterAnnotations(
  bookDir: string,
  chapterNumber: number,
): Promise<ChapterAnnotationFile> {
  assertChapterNumber(chapterNumber);
  try {
    const raw = await readFile(annotationsPath(bookDir, chapterNumber), "utf-8");
    const parsed = JSON.parse(raw) as ChapterAnnotationFile;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.notes)) {
      return emptyFile(chapterNumber);
    }
    return { version: 1, chapterNumber, chapterId: chapterFileId(chapterNumber), notes: parsed.notes };
  } catch (error) {
    if (isMissingFile(error)) return emptyFile(chapterNumber);
    throw error;
  }
}

export async function writeChapterAnnotations(
  bookDir: string,
  chapterNumber: number,
  file: ChapterAnnotationFile,
): Promise<void> {
  assertChapterNumber(chapterNumber);
  await mkdir(join(bookDir, "story", "runtime"), { recursive: true });
  const payload: ChapterAnnotationFile = {
    version: 1,
    chapterNumber,
    chapterId: chapterFileId(chapterNumber),
    notes: file.notes,
  };
  await writeFile(annotationsPath(bookDir, chapterNumber), `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

export function createNote(input: {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly source: string;
  readonly selector: TextQuotePositionSelector;
  readonly comment: string;
  readonly origin?: AnnotationOrigin;
  readonly now?: Date;
}): ChapterNote {
  const now = (input.now ?? new Date()).toISOString();
  return {
    id: randomUUID(),
    bookId: input.bookId,
    chapterNumber: input.chapterNumber,
    baseHash: sha256Source(input.source),
    selector: input.selector,
    comment: input.comment.trim(),
    origin: input.origin ?? "user",
    status: "open",
    createdAt: now,
    updatedAt: now,
  };
}

export function rebaseNotes(source: string, notes: ReadonlyArray<ChapterNote>, now = new Date()): ChapterNote[] {
  const currentHash = sha256Source(source);
  const updatedAt = now.toISOString();
  return notes.map((note) => {
    if (note.status === "accepted" || note.status === "rejected") return note;
    const result = relocateSelector(source, note.selector, {
      baseHash: note.baseHash,
      currentHash,
    });
    if (result.status === "orphaned") {
      if (note.status === "orphaned") return note;
      return { ...note, status: "orphaned", updatedAt };
    }
    const start = result.start!;
    const end = result.end!;
    const selector: TextQuotePositionSelector = {
      exact: source.slice(start, end),
      prefix: source.slice(Math.max(0, start - ANNOTATION_PREFIX_LEN), start),
      suffix: source.slice(end, Math.min(source.length, end + ANNOTATION_SUFFIX_LEN)),
      start,
      end,
    };
    const samePlace =
      selector.start === note.selector.start
      && selector.end === note.selector.end
      && selector.exact === note.selector.exact
      && note.status !== "orphaned";
    if (samePlace) return note;
    return {
      ...note,
      selector,
      status: note.status === "orphaned" ? "open" : note.status,
      updatedAt,
    };
  });
}

export async function listNotes(
  bookDir: string,
  chapterNumber: number,
  source: string,
): Promise<ChapterNote[]> {
  const file = await readChapterAnnotations(bookDir, chapterNumber);
  const notes = rebaseNotes(source, file.notes);
  if (changed(file.notes, notes)) {
    await writeChapterAnnotations(bookDir, chapterNumber, {
      version: 1,
      chapterNumber,
      chapterId: chapterFileId(chapterNumber),
      notes,
    });
  }
  return notes;
}

export async function addNote(
  bookDir: string,
  chapterNumber: number,
  note: ChapterNote,
): Promise<ChapterNote> {
  const file = await readChapterAnnotations(bookDir, chapterNumber);
  const notes = [...file.notes, note];
  await writeChapterAnnotations(bookDir, chapterNumber, {
    version: 1,
    chapterNumber,
    chapterId: chapterFileId(chapterNumber),
    notes,
  });
  return note;
}

export async function getNote(
  bookDir: string,
  chapterNumber: number,
  noteId: string,
): Promise<ChapterNote | null> {
  const file = await readChapterAnnotations(bookDir, chapterNumber);
  return file.notes.find((note) => note.id === noteId) ?? null;
}

export async function updateNote(
  bookDir: string,
  chapterNumber: number,
  noteId: string,
  patch: {
    readonly comment?: string;
    readonly status?: AnnotationStatus;
    readonly suggestion?: NoteSuggestion | null;
  },
  now = new Date(),
): Promise<ChapterNote | null> {
  const file = await readChapterAnnotations(bookDir, chapterNumber);
  const index = file.notes.findIndex((note) => note.id === noteId);
  if (index === -1) return null;
  const current = file.notes[index]!;
  const next = withSuggestion({
    ...current,
    comment: patch.comment !== undefined ? patch.comment.trim() : current.comment,
    status: patch.status ?? current.status,
    updatedAt: now.toISOString(),
  }, patch.suggestion);
  const notes = file.notes.slice();
  notes[index] = next;
  await writeChapterAnnotations(bookDir, chapterNumber, {
    version: 1,
    chapterNumber,
    chapterId: chapterFileId(chapterNumber),
    notes,
  });
  return next;
}

export async function saveNotes(
  bookDir: string,
  chapterNumber: number,
  notes: ReadonlyArray<ChapterNote>,
): Promise<void> {
  await writeChapterAnnotations(bookDir, chapterNumber, {
    version: 1,
    chapterNumber,
    chapterId: chapterFileId(chapterNumber),
    notes: [...notes],
  });
}

function withSuggestion(
  note: ChapterNote,
  suggestion: NoteSuggestion | null | undefined,
): ChapterNote {
  if (suggestion === undefined) return note;
  const { suggestion: _drop, ...rest } = note;
  if (suggestion === null) return rest;
  return { ...rest, suggestion };
}

export async function deleteNote(
  bookDir: string,
  chapterNumber: number,
  noteId: string,
): Promise<boolean> {
  const file = await readChapterAnnotations(bookDir, chapterNumber);
  const notes = file.notes.filter((note) => note.id !== noteId);
  if (notes.length === file.notes.length) return false;
  await writeChapterAnnotations(bookDir, chapterNumber, {
    version: 1,
    chapterNumber,
    chapterId: chapterFileId(chapterNumber),
    notes,
  });
  return true;
}

function emptyFile(chapterNumber: number): ChapterAnnotationFile {
  return { version: 1, chapterNumber, chapterId: chapterFileId(chapterNumber), notes: [] };
}

function chapterFileId(chapterNumber: number): string {
  return `chapter-${padChapter(chapterNumber)}`;
}

function changed(before: ReadonlyArray<ChapterNote>, after: ReadonlyArray<ChapterNote>): boolean {
  if (before.length !== after.length) return true;
  return before.some((note, i) => note !== after[i]);
}

function padChapter(chapterNumber: number): string {
  return String(chapterNumber).padStart(4, "0");
}

function assertChapterNumber(chapterNumber: number): void {
  if (!Number.isInteger(chapterNumber) || chapterNumber < 1) {
    throw new Error(`Invalid chapter number: ${chapterNumber}`);
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
