/**
 * Shared long-task estimate + explicit cancel. Used by shorts assist and note-revise.
 */

import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import {
  LONG_TASK_ID_RE,
  abortLongTask,
  estimateLongTaskMs,
  resolveLongTaskMsPerChar,
} from "../lib/long-task.js";

export function registerLongTaskRoutes(app: Hono): void {
  app.get("/api/v1/long-tasks/estimate", (c) => {
    const raw = c.req.query("chars") ?? "0";
    const parsed = Number(raw);
    const charCount = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
    const msPerChar = resolveLongTaskMsPerChar();
    return c.json({
      charCount,
      estimateMs: estimateLongTaskMs(charCount, msPerChar),
      msPerChar,
      reference: { chars: 11_000, minutes: [6, 7] },
    });
  });

  app.post("/api/v1/long-tasks/:taskId/cancel", (c) => {
    const taskId = c.req.param("taskId");
    if (!LONG_TASK_ID_RE.test(taskId)) {
      throw new ApiError(400, "INVALID_TASK_ID", "taskId must be 1-80 url-safe characters");
    }
    const cancelled = abortLongTask(taskId);
    if (!cancelled) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Long task "${taskId}" is not running`);
    }
    return c.json({ ok: true, cancelled: true, taskId });
  });
}
