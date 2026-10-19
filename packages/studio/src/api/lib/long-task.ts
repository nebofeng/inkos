/**
 * Cancellable long LLM tasks + duration estimates.
 * 1.1 万字 ≈ 6–7 分钟；系数可用 INKOS_LONG_TASK_MS_PER_CHAR 覆盖。
 */

import { ApiError } from "../errors.js";

export const LONG_TASK_REF_CHARS = 11_000;
export const LONG_TASK_REF_MS = 6.5 * 60 * 1000;
export const DEFAULT_LONG_TASK_MS_PER_CHAR = LONG_TASK_REF_MS / LONG_TASK_REF_CHARS;
export const LONG_TASK_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;

const tasks = new Map<string, AbortController>();

export function resolveLongTaskMsPerChar(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return override;
  }
  const raw = typeof process !== "undefined" ? process.env?.INKOS_LONG_TASK_MS_PER_CHAR : undefined;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LONG_TASK_MS_PER_CHAR;
}

export function estimateLongTaskMs(charCount: number, msPerChar?: number): number {
  const n = Number.isFinite(charCount) ? Math.max(0, charCount) : 0;
  return Math.round(n * resolveLongTaskMsPerChar(msPerChar));
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  if (name === "AbortError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /aborted|AbortError|This operation was aborted/i.test(message);
}

export function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const live = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (live.length === 0) return new AbortController().signal;
  if (live.length === 1) return live[0]!;
  if (typeof AbortSignal.any === "function") return AbortSignal.any(live);
  const controller = new AbortController();
  const onAbort = (event: Event) => {
    const reason = (event.target as AbortSignal | null)?.reason;
    if (!controller.signal.aborted) controller.abort(reason);
  };
  for (const signal of live) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

export function parseTaskId(value: unknown, fallback: () => string): string {
  if (value === undefined || value === null || value === "") return fallback();
  if (typeof value !== "string" || !LONG_TASK_ID_RE.test(value)) {
    throw new ApiError(400, "INVALID_TASK_ID", "taskId must be 1-80 url-safe characters");
  }
  return value;
}

export function registerLongTask(taskId: string): AbortController {
  const existing = tasks.get(taskId);
  if (existing && !existing.signal.aborted) {
    throw new ApiError(409, "TASK_IN_PROGRESS", `Long task "${taskId}" is already running`);
  }
  const controller = new AbortController();
  tasks.set(taskId, controller);
  return controller;
}

export function abortLongTask(taskId: string): boolean {
  const controller = tasks.get(taskId);
  if (!controller) return false;
  if (!controller.signal.aborted) {
    controller.abort(abortReason());
  }
  return true;
}

export function unregisterLongTask(taskId: string, controller?: AbortController): void {
  const current = tasks.get(taskId);
  if (!current) return;
  if (controller && current !== controller) return;
  tasks.delete(taskId);
}

export function resetLongTasksForTests(): void {
  for (const controller of tasks.values()) {
    if (!controller.signal.aborted) controller.abort(abortReason());
  }
  tasks.clear();
}

function abortReason(): DOMException | Error {
  try {
    return new DOMException("Task cancelled", "AbortError");
  } catch {
    const error = new Error("Task cancelled");
    error.name = "AbortError";
    return error;
  }
}
