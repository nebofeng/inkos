import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LONG_TASK_MS_PER_CHAR,
  LONG_TASK_REF_CHARS,
  abortLongTask,
  combineAbortSignals,
  estimateLongTaskMs,
  isAbortError,
  parseTaskId,
  registerLongTask,
  resetLongTasksForTests,
  resolveLongTaskMsPerChar,
  unregisterLongTask,
} from "./long-task.js";

afterEach(() => {
  resetLongTasksForTests();
  delete process.env.INKOS_LONG_TASK_MS_PER_CHAR;
});

describe("long-task estimate", () => {
  it("maps 1.1 万字 to about 6.5 minutes", () => {
    expect(estimateLongTaskMs(LONG_TASK_REF_CHARS)).toBe(390_000);
    expect(DEFAULT_LONG_TASK_MS_PER_CHAR).toBeCloseTo(390_000 / 11_000);
  });

  it("honors INKOS_LONG_TASK_MS_PER_CHAR", () => {
    process.env.INKOS_LONG_TASK_MS_PER_CHAR = "10";
    expect(resolveLongTaskMsPerChar()).toBe(10);
    expect(estimateLongTaskMs(100)).toBe(1000);
  });
});

describe("long-task registry", () => {
  it("combines request disconnect and explicit cancel", () => {
    const request = new AbortController();
    const task = registerLongTask("task-1");
    const combined = combineAbortSignals(request.signal, task.signal);
    expect(combined.aborted).toBe(false);
    expect(abortLongTask("task-1")).toBe(true);
    expect(combined.aborted).toBe(true);
    unregisterLongTask("task-1", task);
  });

  it("rejects a second register for the same running id", () => {
    registerLongTask("dup");
    expect(() => registerLongTask("dup")).toThrow(/already running/);
  });

  it("parseTaskId falls back and rejects junk", () => {
    expect(parseTaskId(undefined, () => "generated")).toBe("generated");
    expect(() => parseTaskId("bad id", () => "x")).toThrow(/taskId/);
  });

  it("detects abort errors", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(isAbortError(err)).toBe(true);
    expect(isAbortError(new Error("boom"))).toBe(false);
  });
});
