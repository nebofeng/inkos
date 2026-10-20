/**
 * Frontend API client for cancellable long LLM tasks and note-revise.
 */

import { fetchJson } from "../hooks/use-api";
import { estimateLongTaskMs } from "../api/lib/long-task";
import type { NoteRevisePatch, UnmatchedPatch } from "../api/lib/note-revise";

export { estimateLongTaskMs };

export interface LongTaskEstimate {
  readonly charCount: number;
  readonly estimateMs: number;
  readonly msPerChar: number;
  readonly reference: { readonly chars: number; readonly minutes: readonly [number, number] };
}

export interface NoteReviseResponse {
  readonly taskId: string;
  readonly estimateMs: number;
  readonly charCount: number;
  readonly chapterHash: string;
  readonly patches: ReadonlyArray<NoteRevisePatch>;
  readonly unmatched: ReadonlyArray<UnmatchedPatch>;
}

export interface NoteReviseApplyResponse {
  readonly ok: true;
  readonly chapterNumber: number;
  readonly chapterHash: string;
  readonly appliedIds: ReadonlyArray<string>;
  readonly versionId?: string;
}

export interface ShortsAssistResponse {
  readonly reply: string;
  readonly candidateMarkdown?: string;
  readonly taskId: string;
  readonly estimateMs: number;
  readonly charCount?: number;
}

export interface CancelLongTaskResponse {
  readonly ok: true;
  readonly cancelled: true;
  readonly taskId: string;
}

export function createLongTaskSession(options?: {
  readonly charCount?: number;
  readonly msPerChar?: number;
  readonly taskId?: string;
  readonly now?: () => number;
}): {
  taskId: string;
  signal: AbortSignal;
  estimateMs: number;
  start: () => void;
  elapsedMs: () => number;
  cancel: () => void;
  get cancelled(): boolean;
} {
  const now = options?.now ?? (() => Date.now());
  const controller = new AbortController();
  const taskId = options?.taskId ?? crypto.randomUUID();
  const estimateMs = estimateLongTaskMs(options?.charCount ?? 0, options?.msPerChar);
  let startedAt: number | null = null;
  return {
    taskId,
    get signal() {
      return controller.signal;
    },
    estimateMs,
    start() {
      startedAt = now();
    },
    elapsedMs() {
      return startedAt == null ? 0 : Math.max(0, now() - startedAt);
    },
    cancel() {
      if (!controller.signal.aborted) controller.abort();
    },
    get cancelled() {
      return controller.signal.aborted;
    },
  };
}

export async function fetchLongTaskEstimate(
  charCount: number,
  deps?: { readonly fetchImpl?: typeof fetch },
): Promise<LongTaskEstimate> {
  return fetchJson<LongTaskEstimate>(
    `/long-tasks/estimate?chars=${Math.max(0, Math.floor(charCount))}`,
    {},
    deps,
  );
}

export async function cancelLongTask(
  taskId: string,
  deps?: { readonly fetchImpl?: typeof fetch },
): Promise<CancelLongTaskResponse | null> {
  try {
    return await fetchJson<CancelLongTaskResponse>(
      `/long-tasks/${encodeURIComponent(taskId)}/cancel`,
      { method: "POST" },
      deps,
    );
  } catch (error) {
    if (error instanceof Error && /not running|TASK_NOT_FOUND|404/i.test(error.message)) {
      return null;
    }
    throw error;
  }
}

export async function postNoteRevise(
  bookId: string,
  chapterNumber: number,
  body: {
    readonly noteIds?: ReadonlyArray<string>;
    readonly baseHash: string;
    readonly taskId?: string;
  },
  deps?: { readonly fetchImpl?: typeof fetch; readonly signal?: AbortSignal },
): Promise<NoteReviseResponse> {
  return fetchJson<NoteReviseResponse>(
    `/books/${encodeURIComponent(bookId)}/chapters/${chapterNumber}/note-revise`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: deps?.signal,
    },
    { fetchImpl: deps?.fetchImpl, skipCache: true },
  );
}

export async function applyNoteRevise(
  bookId: string,
  chapterNumber: number,
  body: { readonly acceptIds: ReadonlyArray<string>; readonly baseHash?: string },
  deps?: { readonly fetchImpl?: typeof fetch },
): Promise<NoteReviseApplyResponse> {
  return fetchJson<NoteReviseApplyResponse>(
    `/books/${encodeURIComponent(bookId)}/chapters/${chapterNumber}/note-revise/apply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    { fetchImpl: deps?.fetchImpl, skipCache: true },
  );
}

export async function postShortsAssist(
  shortId: string,
  body: {
    readonly instruction: string;
    readonly action?: string;
    readonly taskId?: string;
    readonly targetWords?: number;
    readonly selectedText?: string;
    readonly messages?: ReadonlyArray<{ role: string; content: string }>;
  },
  deps?: { readonly fetchImpl?: typeof fetch; readonly signal?: AbortSignal },
): Promise<ShortsAssistResponse> {
  return fetchJson<ShortsAssistResponse>(
    `/shorts/${encodeURIComponent(shortId)}/assist`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: deps?.signal,
    },
    { fetchImpl: deps?.fetchImpl, skipCache: true },
  );
}
