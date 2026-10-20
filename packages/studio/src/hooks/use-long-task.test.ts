import { createElement, useEffect } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { useLongTask } from "./use-long-task";

describe("useLongTask", () => {
  it("exposes run/cancel and seeds estimate from charCount", () => {
    let captured: ReturnType<typeof useLongTask> | undefined;
    function Probe() {
      captured = useLongTask({ charCount: 11_000 });
      return null;
    }
    renderToString(createElement(Probe));
    expect(captured).toBeDefined();
    expect(captured!.estimateMs).toBe(390_000);
    expect(typeof captured!.run).toBe("function");
    expect(typeof captured!.cancel).toBe("function");
    expect(captured!.running).toBe(false);
  });

  it("treats AbortError as cancelled instead of error", async () => {
    let captured: ReturnType<typeof useLongTask<string>> | undefined;
    function Probe() {
      captured = useLongTask<string>({ charCount: 10 });
      return null;
    }
    renderToString(createElement(Probe));

    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    await expect(captured!.run(async () => {
      throw abortErr;
    })).resolves.toBeUndefined();

    await expect(captured!.run(async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
  });

  it("does not restart a completed effect on SSR probe", () => {
    const spy = vi.fn();
    function Probe() {
      const task = useLongTask();
      useEffect(() => {
        spy(task.running);
      }, [task.running]);
      return null;
    }
    renderToString(createElement(Probe));
    expect(spy).not.toHaveBeenCalled();
  });
});
