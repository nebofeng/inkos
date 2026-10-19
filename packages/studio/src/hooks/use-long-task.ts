import { useCallback, useEffect, useRef, useState } from "react";
import { isAbortError } from "../api/lib/long-task";
import {
  cancelLongTask,
  createLongTaskSession,
  estimateLongTaskMs,
} from "../lib/long-task-client";

export interface UseLongTaskOptions {
  readonly charCount?: number;
  readonly msPerChar?: number;
}

export interface LongTaskRunContext {
  readonly taskId: string;
  readonly signal: AbortSignal;
  readonly estimateMs: number;
}

/**
 * Elapsed timer + estimate + cancel (AbortController + POST /long-tasks/:id/cancel).
 * UI is out of scope this phase; callers wire their own buttons.
 */
export function useLongTask<T>(options?: UseLongTaskOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const sessionRef = useRef<ReturnType<typeof createLongTaskSession> | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [estimateMs, setEstimateMs] = useState(() => estimateLongTaskMs(options?.charCount ?? 0, options?.msPerChar));
  const [running, setRunning] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      setElapsedMs(sessionRef.current?.elapsedMs() ?? 0);
    }, 250);
    return () => clearInterval(timer);
  }, [running]);

  const cancel = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    session.cancel();
    setCancelled(true);
    await cancelLongTask(session.taskId);
  }, []);

  const run = useCallback(async (fn: (ctx: LongTaskRunContext) => Promise<T>): Promise<T | undefined> => {
    const session = createLongTaskSession({
      charCount: optionsRef.current?.charCount,
      msPerChar: optionsRef.current?.msPerChar,
    });
    sessionRef.current = session;
    session.start();
    setTaskId(session.taskId);
    setEstimateMs(session.estimateMs);
    setElapsedMs(0);
    setRunning(true);
    setCancelled(false);
    setError(null);
    try {
      return await fn({
        taskId: session.taskId,
        signal: session.signal,
        estimateMs: session.estimateMs,
      });
    } catch (caught) {
      if (isAbortError(caught) || session.cancelled) {
        setCancelled(true);
        return undefined;
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      throw caught;
    } finally {
      setElapsedMs(session.elapsedMs());
      setRunning(false);
    }
  }, []);

  return {
    taskId,
    elapsedMs,
    estimateMs,
    running,
    cancelled,
    error,
    run,
    cancel,
  };
}
