import { afterEach, describe, expect, it, vi } from "vitest";
import { resetApiCacheForTests } from "./api-cache";
import {
  applyNoteRevise,
  createAnnotation,
  deleteAnnotation,
  listAnnotations,
  noteRevise,
  updateAnnotation,
} from "./annotation-client";

afterEach(() => {
  resetApiCacheForTests();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const NOTE = {
  id: "n1",
  bookId: "demo",
  chapterNumber: 1,
  baseHash: "abc",
  selector: { exact: "门口的灯灭了。", prefix: "", suffix: "", start: 8, end: 16 },
  comment: "语气再冷",
  origin: "user",
  status: "open",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("annotation client", () => {
  it("lists, creates, updates and deletes notes against the chapter annotations routes", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && path.endsWith("/annotations")) {
        return jsonResponse({ chapterNumber: 1, chapterHash: "abc", notes: [NOTE] });
      }
      if (method === "POST" && path.endsWith("/annotations")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          comment: "语气再冷",
          start: 8,
          end: 16,
          origin: "user",
        });
        return jsonResponse({ note: NOTE }, 201);
      }
      if (method === "PATCH" && path.endsWith("/annotations/n1")) {
        expect(JSON.parse(String(init?.body))).toEqual({ status: "rejected" });
        return jsonResponse({ note: { ...NOTE, status: "rejected" } });
      }
      if (method === "DELETE" && path.endsWith("/annotations/n1")) {
        return jsonResponse({ ok: true, id: "n1" });
      }
      throw new Error(`unexpected ${method} ${path}`);
    });

    await expect(listAnnotations("demo", 1, { fetchImpl })).resolves.toMatchObject({
      chapterNumber: 1,
      chapterHash: "abc",
      notes: [{ id: "n1" }],
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/api/v1/books/demo/chapters/1/annotations");

    await expect(
      createAnnotation("demo", 1, { comment: "语气再冷", start: 8, end: 16, origin: "user" }, { fetchImpl }),
    ).resolves.toMatchObject({ note: { id: "n1", status: "open" } });

    await expect(
      updateAnnotation("demo", 1, "n1", { status: "rejected" }, { fetchImpl }),
    ).resolves.toMatchObject({ note: { status: "rejected" } });

    await expect(deleteAnnotation("demo", 1, "n1", { fetchImpl })).resolves.toEqual({ ok: true, id: "n1" });
  });

  it("posts note-revise with AbortSignal and apply with acceptIds + baseHash", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url);
      if (path.endsWith("/note-revise/apply")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ acceptIds: ["n1"], baseHash: "abc" });
        return jsonResponse({
          ok: true,
          chapterNumber: 1,
          chapterHash: "def",
          appliedIds: ["n1"],
          versionId: "v1",
        });
      }
      if (path.endsWith("/note-revise")) {
        expect(init?.method).toBe("POST");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(JSON.parse(String(init?.body))).toEqual({
          baseHash: "abc",
          noteIds: ["n1"],
          taskId: "t1",
        });
        return jsonResponse({
          taskId: "t1",
          estimateMs: 1000,
          charCount: 20,
          chapterHash: "abc",
          patches: [{
            noteId: "n1",
            targetText: "门口的灯灭了。",
            replacementText: "门口的灯早就灭了。",
            start: 8,
            end: 16,
          }],
          unmatched: [],
        });
      }
      throw new Error(`unexpected ${path}`);
    });

    const signal = new AbortController().signal;
    await expect(
      noteRevise("demo", 1, { baseHash: "abc", noteIds: ["n1"], taskId: "t1" }, { fetchImpl, signal }),
    ).resolves.toMatchObject({
      taskId: "t1",
      patches: [{ noteId: "n1" }],
      unmatched: [],
    });

    await expect(
      applyNoteRevise("demo", 1, { acceptIds: ["n1"], baseHash: "abc" }, { fetchImpl }),
    ).resolves.toEqual({
      ok: true,
      chapterNumber: 1,
      chapterHash: "def",
      appliedIds: ["n1"],
      versionId: "v1",
    });
  });
});
