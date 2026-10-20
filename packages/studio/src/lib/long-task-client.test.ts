import { afterEach, describe, expect, it, vi } from "vitest";
import { resetApiCacheForTests } from "./api-cache";
import {
  applyNoteRevise,
  cancelLongTask,
  createLongTaskSession,
  estimateLongTaskMs,
  fetchLongTaskEstimate,
  postNoteRevise,
  postShortsAssist,
} from "./long-task-client";

afterEach(() => {
  resetApiCacheForTests();
});

describe("long-task client", () => {
  it("creates a cancellable session with 1.1 万字 ≈ 6.5 分钟", () => {
    let now = 1_000;
    const session = createLongTaskSession({
      charCount: 11_000,
      taskId: "t1",
      now: () => now,
    });
    expect(session.estimateMs).toBe(390_000);
    expect(estimateLongTaskMs(11_000)).toBe(390_000);
    session.start();
    now = 1_250;
    expect(session.elapsedMs()).toBe(250);
    session.cancel();
    expect(session.cancelled).toBe(true);
    expect(session.signal.aborted).toBe(true);
  });

  it("posts note-revise, apply, shorts assist and cancel with the abort signal", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes("/estimate")) {
        return new Response(JSON.stringify({
          charCount: 100,
          estimateMs: 3500,
          msPerChar: 35,
          reference: { chars: 11000, minutes: [6, 7] },
        }), { headers: { "Content-Type": "application/json" } });
      }
      if (String(url).includes("/cancel")) {
        return new Response(JSON.stringify({ ok: true, cancelled: true, taskId: "t1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (String(url).includes("/apply")) {
        return new Response(JSON.stringify({
          ok: true,
          chapterNumber: 1,
          chapterHash: "abc",
          appliedIds: ["n1"],
          versionId: "v1",
        }), { headers: { "Content-Type": "application/json" } });
      }
      if (String(url).includes("/note-revise")) {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return new Response(JSON.stringify({
          taskId: "t1",
          estimateMs: 1000,
          charCount: 20,
          chapterHash: "abc",
          patches: [],
          unmatched: [],
        }), { headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        reply: "ok",
        taskId: "t1",
        estimateMs: 1000,
      }), { headers: { "Content-Type": "application/json" } });
    });

    await expect(fetchLongTaskEstimate(100, { fetchImpl })).resolves.toMatchObject({ estimateMs: 3500 });
    const signal = new AbortController().signal;
    await postNoteRevise("demo", 1, { baseHash: "abc", taskId: "t1" }, { fetchImpl, signal });
    await applyNoteRevise("demo", 1, { acceptIds: ["n1"] }, { fetchImpl });
    await postShortsAssist("s1", { instruction: "改写", taskId: "t1" }, { fetchImpl, signal });
    await expect(cancelLongTask("t1", { fetchImpl })).resolves.toMatchObject({ cancelled: true });
  });
});
