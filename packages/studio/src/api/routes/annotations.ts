/**
 * Per-chapter annotation CRUD. Kept out of server.ts.
 */

import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import { isSafeBookId } from "../safety.js";
import {
  ANNOTATION_EXACT_MAX,
  type AnnotationOrigin,
  type AnnotationStatus,
  prepareSourceSelection,
} from "../lib/annotation-anchors.js";
import {
  addNote,
  createNote,
  deleteNote,
  getNote,
  listNotes,
  sha256Source,
  updateNote,
} from "../lib/annotation-store.js";

const ORIGINS = new Set<AnnotationOrigin>(["user", "ai"]);
const STATUSES = new Set<AnnotationStatus>(["open", "suggested", "accepted", "rejected", "orphaned"]);

export interface AnnotationRouteDeps {
  readonly root: string;
}

export function registerAnnotationRoutes(app: Hono, deps: AnnotationRouteDeps): void {
  app.get("/api/v1/books/:id/chapters/:num/annotations", async (c) => {
    const bookId = requiredBookId(c.req.param("id"));
    const chapterNumber = requiredChapterNumber(c.req.param("num"));
    const bookDir = await requireBookDir(deps.root, bookId);
    const source = await readChapterSource(bookDir, chapterNumber);
    const notes = await listNotes(bookDir, chapterNumber, source);
    return c.json({ chapterNumber, chapterHash: sha256Source(source), notes });
  });

  app.post("/api/v1/books/:id/chapters/:num/annotations", async (c) => {
    const bookId = requiredBookId(c.req.param("id"));
    const chapterNumber = requiredChapterNumber(c.req.param("num"));
    const bookDir = await requireBookDir(deps.root, bookId);
    const source = await readChapterSource(bookDir, chapterNumber);
    const body = await readJsonObject(c);
    const comment = typeof body.comment === "string" ? body.comment.trim() : "";
    if (!comment) {
      throw new ApiError(400, "INVALID_COMMENT", "comment is required");
    }
    const start = requiredOffset(body.start, "start");
    const end = requiredOffset(body.end, "end");
    if (end <= start) {
      throw new ApiError(400, "INVALID_RANGE", "end must be greater than start");
    }
    if (end - start > ANNOTATION_EXACT_MAX) {
      throw new ApiError(400, "EXACT_TOO_LONG", `selection exceeds ${ANNOTATION_EXACT_MAX} characters`);
    }
    const origin = parseOrigin(body.origin);
    const selector = prepareSourceSelection(source, start, end);
    const note = createNote({ bookId, chapterNumber, source, selector, comment, origin });
    await addNote(bookDir, chapterNumber, note);
    return c.json({ note }, 201);
  });

  app.get("/api/v1/books/:id/chapters/:num/annotations/:noteId", async (c) => {
    const bookId = requiredBookId(c.req.param("id"));
    const chapterNumber = requiredChapterNumber(c.req.param("num"));
    const noteId = requiredNoteId(c.req.param("noteId"));
    const bookDir = await requireBookDir(deps.root, bookId);
    const note = await getNote(bookDir, chapterNumber, noteId);
    if (!note) throw new ApiError(404, "NOTE_NOT_FOUND", `Annotation "${noteId}" not found`);
    return c.json({ note });
  });

  app.patch("/api/v1/books/:id/chapters/:num/annotations/:noteId", async (c) => {
    const bookId = requiredBookId(c.req.param("id"));
    const chapterNumber = requiredChapterNumber(c.req.param("num"));
    const noteId = requiredNoteId(c.req.param("noteId"));
    const bookDir = await requireBookDir(deps.root, bookId);
    const body = await readJsonObject(c);
    const patch: { comment?: string; status?: AnnotationStatus } = {};
    if (body.comment !== undefined) {
      if (typeof body.comment !== "string" || !body.comment.trim()) {
        throw new ApiError(400, "INVALID_COMMENT", "comment must be a non-empty string");
      }
      patch.comment = body.comment;
    }
    if (body.status !== undefined) {
      if (typeof body.status !== "string" || !STATUSES.has(body.status as AnnotationStatus)) {
        throw new ApiError(400, "INVALID_STATUS", `Invalid status: "${String(body.status)}"`);
      }
      patch.status = body.status as AnnotationStatus;
    }
    const note = await updateNote(bookDir, chapterNumber, noteId, patch);
    if (!note) throw new ApiError(404, "NOTE_NOT_FOUND", `Annotation "${noteId}" not found`);
    return c.json({ note });
  });

  app.delete("/api/v1/books/:id/chapters/:num/annotations/:noteId", async (c) => {
    const bookId = requiredBookId(c.req.param("id"));
    const chapterNumber = requiredChapterNumber(c.req.param("num"));
    const noteId = requiredNoteId(c.req.param("noteId"));
    const bookDir = await requireBookDir(deps.root, bookId);
    const deleted = await deleteNote(bookDir, chapterNumber, noteId);
    if (!deleted) throw new ApiError(404, "NOTE_NOT_FOUND", `Annotation "${noteId}" not found`);
    return c.json({ ok: true, id: noteId });
  });
}

function requiredBookId(value: unknown): string {
  if (typeof value !== "string" || !isSafeBookId(value)) {
    throw new ApiError(400, "INVALID_BOOK_ID", `Invalid book ID: "${String(value)}"`);
  }
  return value;
}

function requiredChapterNumber(value: unknown): number {
  const num = typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isInteger(num) || num < 1) {
    throw new ApiError(400, "INVALID_CHAPTER", `Invalid chapter number: "${String(value)}"`);
  }
  return num;
}

function requiredNoteId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(400, "INVALID_NOTE_ID", "noteId is required");
  }
  return value;
}

function requiredOffset(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ApiError(400, "INVALID_RANGE", `${field} must be a non-negative integer`);
  }
  return value;
}

function parseOrigin(value: unknown): AnnotationOrigin {
  if (value === undefined || value === null || value === "") return "user";
  if (typeof value === "string" && ORIGINS.has(value as AnnotationOrigin)) {
    return value as AnnotationOrigin;
  }
  throw new ApiError(400, "INVALID_ORIGIN", `Invalid origin: "${String(value)}"`);
}

async function requireBookDir(root: string, bookId: string): Promise<string> {
  const bookDir = join(root, "books", bookId);
  try {
    await access(join(bookDir, "book.json"));
  } catch {
    throw new ApiError(404, "BOOK_NOT_FOUND", `Book "${bookId}" not found`);
  }
  return bookDir;
}

async function readChapterSource(bookDir: string, chapterNumber: number): Promise<string> {
  const chaptersDir = join(bookDir, "chapters");
  let files: string[];
  try {
    files = await readdir(chaptersDir);
  } catch {
    throw new ApiError(404, "CHAPTER_NOT_FOUND", `Chapter ${chapterNumber} not found`);
  }
  const padded = String(chapterNumber).padStart(4, "0");
  const match = files.find((file) => file.startsWith(padded) && file.endsWith(".md"));
  if (!match) {
    throw new ApiError(404, "CHAPTER_NOT_FOUND", `Chapter ${chapterNumber} not found`);
  }
  return readFile(join(chaptersDir, match), "utf-8");
}

async function readJsonObject(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    // empty / invalid JSON
  }
  return {};
}
