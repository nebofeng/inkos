/**
 * Frontend API client for per-chapter annotation CRUD and note-revise.
 * Types match src/api/routes/annotations.ts and note-revise.ts.
 */

import type { AnnotationOrigin, AnnotationStatus } from "../api/lib/annotation-anchors";
import type { ChapterNote } from "../api/lib/annotation-store";
import { fetchJson } from "../hooks/use-api";
import {
  applyNoteRevise as postApplyNoteRevise,
  postNoteRevise,
  type NoteReviseApplyResponse,
  type NoteReviseResponse,
} from "./long-task-client";

export type { AnnotationOrigin, AnnotationStatus, ChapterNote, NoteReviseApplyResponse, NoteReviseResponse };

export interface AnnotationClientDeps {
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}

export interface AnnotationListResponse {
  readonly chapterNumber: number;
  readonly chapterHash: string;
  readonly notes: ReadonlyArray<ChapterNote>;
}

export interface CreateAnnotationInput {
  readonly comment: string;
  readonly start: number;
  readonly end: number;
  readonly origin?: AnnotationOrigin;
}

export interface UpdateAnnotationInput {
  readonly comment?: string;
  readonly status?: AnnotationStatus;
}

export interface NoteReviseInput {
  readonly baseHash: string;
  readonly noteIds?: ReadonlyArray<string>;
  readonly taskId?: string;
}

export interface ApplyNoteReviseInput {
  readonly acceptIds: ReadonlyArray<string>;
  readonly baseHash: string;
}

function annotationsPath(bookId: string, chapterNumber: number, noteId?: string): string {
  const base = `/books/${encodeURIComponent(bookId)}/chapters/${chapterNumber}/annotations`;
  return noteId ? `${base}/${encodeURIComponent(noteId)}` : base;
}

function clientOpts(deps?: AnnotationClientDeps): { readonly fetchImpl?: typeof fetch; readonly skipCache: true } {
  return { fetchImpl: deps?.fetchImpl, skipCache: true };
}

export async function listAnnotations(
  bookId: string,
  chapterNumber: number,
  deps?: AnnotationClientDeps,
): Promise<AnnotationListResponse> {
  return fetchJson<AnnotationListResponse>(
    annotationsPath(bookId, chapterNumber),
    { signal: deps?.signal },
    clientOpts(deps),
  );
}

export async function createAnnotation(
  bookId: string,
  chapterNumber: number,
  input: CreateAnnotationInput,
  deps?: AnnotationClientDeps,
): Promise<{ note: ChapterNote }> {
  return fetchJson<{ note: ChapterNote }>(
    annotationsPath(bookId, chapterNumber),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: deps?.signal,
    },
    clientOpts(deps),
  );
}

export async function updateAnnotation(
  bookId: string,
  chapterNumber: number,
  noteId: string,
  input: UpdateAnnotationInput,
  deps?: AnnotationClientDeps,
): Promise<{ note: ChapterNote }> {
  return fetchJson<{ note: ChapterNote }>(
    annotationsPath(bookId, chapterNumber, noteId),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: deps?.signal,
    },
    clientOpts(deps),
  );
}

export async function deleteAnnotation(
  bookId: string,
  chapterNumber: number,
  noteId: string,
  deps?: AnnotationClientDeps,
): Promise<{ ok: true; id: string }> {
  return fetchJson<{ ok: true; id: string }>(
    annotationsPath(bookId, chapterNumber, noteId),
    { method: "DELETE", signal: deps?.signal },
    clientOpts(deps),
  );
}

/** POST /note-revise — emit in-memory patches only; supports AbortSignal. */
export async function noteRevise(
  bookId: string,
  chapterNumber: number,
  body: NoteReviseInput,
  deps?: AnnotationClientDeps,
): Promise<NoteReviseResponse> {
  return postNoteRevise(bookId, chapterNumber, body, deps);
}

/** POST /note-revise/apply — acceptIds + baseHash; writes only accepted patches. */
export async function applyNoteRevise(
  bookId: string,
  chapterNumber: number,
  body: ApplyNoteReviseInput,
  deps?: { readonly fetchImpl?: typeof fetch },
): Promise<NoteReviseApplyResponse> {
  return postApplyNoteRevise(bookId, chapterNumber, body, deps);
}
