/**
 * Patch-only annotation revise: LLM emits per-note patches, apply writes only accepted ones.
 */

import { randomUUID } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import {
  ReviserAgent,
  StateManager,
  createLLMClient,
  executeEditTransaction,
  listChapterVersions,
  loadProjectConfig,
  type EditExecutionDeps,
  type ExecutedEditTransaction,
  type ProjectConfig,
} from "@actalk/inkos-core";
import { ApiError } from "../errors.js";
import { isSafeBookId } from "../safety.js";
import {
  type ChapterNote,
  listNotes,
  rebaseNotes,
  saveNotes,
  sha256Source,
} from "../lib/annotation-store.js";
import {
  NOTE_REVISE_MAX,
  applyAcceptedPatches,
  matchPatchesToNotes,
  notesToAuditIssues,
  overlappingPatchIds,
  type SpotPatch,
} from "../lib/note-revise.js";
import {
  combineAbortSignals,
  estimateLongTaskMs,
  isAbortError,
  parseTaskId,
  registerLongTask,
  unregisterLongTask,
} from "../lib/long-task.js";

export interface NoteReviseLlmInput {
  readonly root: string;
  readonly bookDir: string;
  readonly source: string;
  readonly chapterNumber: number;
  readonly issues: ReturnType<typeof notesToAuditIssues>;
  readonly genre?: string;
  readonly signal?: AbortSignal;
}

export interface NoteReviseRouteDeps {
  readonly root: string;
  readonly reviseChapter?: (input: NoteReviseLlmInput) => Promise<{ patches: ReadonlyArray<SpotPatch> }>;
  readonly executeEdit?: (
    deps: EditExecutionDeps,
    request: {
      readonly kind: "chapter-replace";
      readonly bookId: string;
      readonly chapterNumber: number;
      readonly fullText: string;
      readonly versionSource?: "revision";
    },
  ) => Promise<ExecutedEditTransaction>;
}

export function registerNoteReviseRoutes(app: Hono, deps: NoteReviseRouteDeps): void {
  const state = new StateManager(deps.root);

  app.post("/api/v1/books/:id/chapters/:num/note-revise", async (c) => {
    const bookId = requiredBookId(c.req.param("id"));
    const chapterNumber = requiredChapterNumber(c.req.param("num"));
    const bookDir = await requireBookDir(deps.root, bookId);
    const source = await readChapterSource(bookDir, chapterNumber);
    const chapterHash = sha256Source(source);
    const body = await readJsonObject(c);
    const baseHash = typeof body.baseHash === "string" ? body.baseHash : "";
    if (!baseHash) {
      throw new ApiError(400, "MISSING_BASE_HASH", "baseHash is required");
    }
    if (baseHash !== chapterHash) {
      throw new ApiError(409, "CHAPTER_HASH_MISMATCH", "Chapter changed since the notes were loaded");
    }

    const allNotes = await listNotes(bookDir, chapterNumber, source);
    const selected = selectNotes(allNotes, body.noteIds);
    if (selected.length === 0) {
      throw new ApiError(400, "NO_NOTES", "No pending notes to revise");
    }
    if (selected.length > NOTE_REVISE_MAX) {
      throw new ApiError(400, "TOO_MANY_NOTES", `At most ${NOTE_REVISE_MAX} notes per request`);
    }

    const taskId = parseTaskId(body.taskId, () => randomUUID());
    const estimateMs = estimateLongTaskMs(source.length);
    const controller = registerLongTask(taskId);
    const signal = combineAbortSignals(c.req.raw.signal, controller.signal);
    try {
      signal.throwIfAborted();
      const llmPatches = await (deps.reviseChapter ?? defaultReviseChapter)({
        root: deps.root,
        bookDir,
        source,
        chapterNumber,
        issues: notesToAuditIssues(selected),
        genre: await readBookGenre(bookDir),
        signal,
      });
      const { patches, unmatched } = matchPatchesToNotes(source, selected, llmPatches.patches);
      const now = new Date().toISOString();
      const byId = new Map(patches.map((patch) => [patch.noteId, patch]));
      const nextNotes = allNotes.map((note) => {
        const patch = byId.get(note.id);
        if (!patch) return note;
        return {
          ...note,
          status: "suggested" as const,
          suggestion: {
            targetText: patch.targetText,
            replacementText: patch.replacementText,
            start: patch.start,
            end: patch.end,
          },
          updatedAt: now,
        };
      });
      await saveNotes(bookDir, chapterNumber, nextNotes);
      return c.json({
        taskId,
        estimateMs,
        charCount: source.length,
        chapterHash,
        patches,
        unmatched,
      });
    } catch (error) {
      throw asTaskError(error, signal);
    } finally {
      unregisterLongTask(taskId, controller);
    }
  });

  app.post("/api/v1/books/:id/chapters/:num/note-revise/apply", async (c) => {
    const bookId = requiredBookId(c.req.param("id"));
    const chapterNumber = requiredChapterNumber(c.req.param("num"));
    const bookDir = await requireBookDir(deps.root, bookId);
    const source = await readChapterSource(bookDir, chapterNumber);
    const body = await readJsonObject(c);
    if (typeof body.baseHash === "string" && body.baseHash !== sha256Source(source)) {
      throw new ApiError(409, "CHAPTER_HASH_MISMATCH", "Chapter changed since the patches were generated");
    }
    const acceptIds = parseIdList(body.acceptIds, "acceptIds");
    if (acceptIds.length === 0) {
      throw new ApiError(400, "INVALID_ACCEPT_IDS", "acceptIds must be a non-empty string array");
    }

    const notes = await listNotes(bookDir, chapterNumber, source);
    const accepted: ChapterNote[] = [];
    for (const id of acceptIds) {
      const note = notes.find((item) => item.id === id);
      if (!note) throw new ApiError(404, "NOTE_NOT_FOUND", `Annotation "${id}" not found`);
      if (!note.suggestion) {
        throw new ApiError(409, "NOTE_HAS_NO_PATCH", `Annotation "${id}" has no suggestion to apply`);
      }
      accepted.push(note);
    }

    const patches = accepted.map((note) => ({
      noteId: note.id,
      targetText: note.suggestion!.targetText,
      replacementText: note.suggestion!.replacementText,
      start: note.suggestion!.start,
      end: note.suggestion!.end,
    }));
    const overlapping = overlappingPatchIds(patches);
    if (overlapping.length > 0) {
      throw new ApiError(409, "OVERLAPPING_PATCHES", `Overlapping patches: ${overlapping.join(", ")}`);
    }

    const { next, applied } = applyAcceptedPatches(source, patches);
    if (applied.length === 0) {
      throw new ApiError(409, "PATCH_NOT_FOUND", "None of the accepted patches could be located in the chapter");
    }
    if (next === source) {
      throw new ApiError(409, "PATCH_NOT_FOUND", "Accepted patches did not change the chapter");
    }

    const releaseLock = await state.acquireBookLock(bookId);
    try {
      const executeEdit = deps.executeEdit ?? executeEditTransaction;
      await executeEdit(
        {
          bookDir: (id) => state.bookDir(id),
          loadChapterIndex: (id) => state.loadChapterIndex(id),
          saveChapterIndex: (id, index) => state.saveChapterIndex(id, index),
        },
        {
          kind: "chapter-replace",
          bookId,
          chapterNumber,
          fullText: next,
          versionSource: "revision",
        },
      );
      const now = new Date();
      const appliedIds = new Set(applied.map((patch) => patch.noteId));
      const remaining = notes.map((note) => {
        if (!appliedIds.has(note.id)) return note;
        const { suggestion: _drop, ...rest } = note;
        return { ...rest, status: "accepted" as const, updatedAt: now.toISOString() };
      });
      const rebased = rebaseNotes(next, remaining, now);
      await saveNotes(bookDir, chapterNumber, rebased);
      const versions = await listChapterVersions(bookDir, chapterNumber);
      return c.json({
        ok: true,
        chapterNumber,
        chapterHash: sha256Source(next),
        appliedIds: applied.map((patch) => patch.noteId),
        versionId: versions[0]?.id,
      });
    } finally {
      await releaseLock();
    }
  });
}

async function defaultReviseChapter(input: NoteReviseLlmInput): Promise<{ patches: SpotPatch[] }> {
  let config: ProjectConfig;
  try {
    config = await loadProjectConfig(input.root, { consumer: "studio", requireApiKey: false });
  } catch {
    config = { name: "default", version: "1.0", llm: { provider: "openai", model: "default" } } as unknown as ProjectConfig;
  }
  const agent = new ReviserAgent({
    client: createLLMClient(config.llm),
    model: config.llm?.model || "default",
    projectRoot: input.root,
    signal: input.signal,
  });
  const result = await agent.reviseChapter(
    input.bookDir,
    input.source,
    input.chapterNumber,
    input.issues,
    "spot-fix",
    input.genre,
  );
  return { patches: result.patches ? [...result.patches] : [] };
}

function selectNotes(notes: ReadonlyArray<ChapterNote>, rawIds: unknown): ChapterNote[] {
  const pending = notes.filter((note) => note.status === "open" || note.status === "suggested");
  if (rawIds === undefined) return pending;
  const ids = parseIdList(rawIds, "noteIds");
  const selected: ChapterNote[] = [];
  for (const id of ids) {
    const note = notes.find((item) => item.id === id);
    if (!note) throw new ApiError(404, "NOTE_NOT_FOUND", `Annotation "${id}" not found`);
    if (note.status === "orphaned") {
      throw new ApiError(409, "NOTE_ORPHANED", `Annotation "${id}" is orphaned`);
    }
    selected.push(note);
  }
  return selected;
}

function parseIdList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ApiError(400, "INVALID_IDS", `${field} must be an array of ids`);
  }
  return [...new Set(value.map((item) => String(item)))];
}

function requiredBookId(value: unknown): string {
  if (typeof value !== "string" || !isSafeBookId(value)) {
    throw new ApiError(400, "INVALID_BOOK_ID", `Invalid book ID: "${String(value)}"`);
  }
  return value;
}

function requiredChapterNumber(value: unknown): number {
  const num = typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(num) || num < 1) {
    throw new ApiError(400, "INVALID_CHAPTER", `Invalid chapter number: "${String(value)}"`);
  }
  return num;
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

async function readBookGenre(bookDir: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(bookDir, "book.json"), "utf-8")) as { genre?: unknown };
    return typeof parsed.genre === "string" ? parsed.genre : undefined;
  } catch {
    return undefined;
  }
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

function asTaskError(error: unknown, signal: AbortSignal): ApiError {
  if (error instanceof ApiError) return error;
  if (isAbortError(error) || signal.aborted) {
    return new ApiError(409, "TASK_CANCELLED", "Task was cancelled");
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ApiError(500, "INTERNAL_ERROR", message);
}
