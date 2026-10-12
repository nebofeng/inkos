import { afterEach, describe, expect, it, vi } from "vitest";
import { resetApiCacheForTests } from "../lib/api-cache";
import { buildApiUrl, deriveInvalidationPaths, fetchJson } from "./use-api";

afterEach(() => {
  resetApiCacheForTests();
});

describe("buildApiUrl", () => {
  it("returns null for blank paths so callers can skip requests", () => {
    expect(buildApiUrl("")).toBeNull();
    expect(buildApiUrl("   ")).toBeNull();
  });

  it("prefixes api paths once", () => {
    expect(buildApiUrl("/books")).toBe("/api/v1/books");
    expect(buildApiUrl("books")).toBe("/api/v1/books");
    expect(buildApiUrl("/api/v1/books")).toBe("/api/v1/books");
  });
});

describe("fetchJson", () => {
  it("surfaces API error payloads on non-ok responses", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Bad request" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchJson("/books", {}, { fetchImpl })).rejects.toThrow("Bad request");
  });

  it("falls back to status text when the body is not JSON", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("boom", {
        status: 500,
        statusText: "Internal Server Error",
        headers: { "Content-Type": "text/plain" },
      }),
    );

    await expect(fetchJson("/books", {}, { fetchImpl })).rejects.toThrow("500 Internal Server Error");
  });

  it("surfaces nested api error messages from structured error payloads", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "INVALID_BOOK_ID", message: "Invalid book ID: ../bad" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchJson("/books/../bad", {}, { fetchImpl })).rejects.toThrow("Invalid book ID: ../bad");
  });

  it("localizes known runtime errors before throwing", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        error: "Latest chapter 1 is state-degraded. Repair state or rewrite that chapter before continuing.",
      }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchJson("/books/demo/write-next", { method: "POST" }, { fetchImpl })).rejects.toThrow(
      "最新第 1 章处于状态降级（state-degraded）。继续写下一章前，请先修复状态，或重写这一章。",
    );
  });
});

describe("deriveInvalidationPaths", () => {
  it("refreshes book collections after creating a book", () => {
    expect(deriveInvalidationPaths("/books/create")).toEqual(["/api/v1/books"]);
    expect(deriveInvalidationPaths("/spinoff/init")).toEqual(["/api/v1/books"]);
    expect(deriveInvalidationPaths("/imitation/init")).toEqual(["/api/v1/books"]);
  });

  it("refreshes both collections and the current book after book mutations", () => {
    expect(deriveInvalidationPaths("/books/demo/write-next")).toEqual([
      "/api/v1/books",
      "/api/v1/books/demo",
    ]);
    expect(deriveInvalidationPaths("/books/demo/chapters/3/approve")).toEqual([
      "/api/v1/books",
      "/api/v1/books/demo",
    ]);
  });

  it("refreshes daemon state after daemon mutations", () => {
    expect(deriveInvalidationPaths("/daemon/start")).toEqual(["/api/v1/daemon"]);
    expect(deriveInvalidationPaths("/daemon/stop")).toEqual(["/api/v1/daemon"]);
  });

  it("refreshes project data after project mutations", () => {
    expect(deriveInvalidationPaths("/project")).toEqual(["/api/v1/project"]);
    expect(deriveInvalidationPaths("/project/language")).toEqual(["/api/v1/project", "/api/v1/project/language"]);
  });

  it("refreshes book caches after rewrite and truth writes", () => {
    expect(deriveInvalidationPaths("/books/demo/rewrite/3")).toEqual([
      "/api/v1/books",
      "/api/v1/books/demo",
    ]);
    expect(deriveInvalidationPaths("/books/demo/truth/world.md")).toEqual([
      "/api/v1/books",
      "/api/v1/books/demo",
    ]);
  });
});

describe("fetchJson cache", () => {
  it("reuses a fresh GET without issuing a second request", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ books: [{ id: "demo" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const first = await fetchJson("/books", {}, { fetchImpl });
    const second = await fetchJson("/books", {}, { fetchImpl });
    expect(first).toEqual({ books: [{ id: "demo" }] });
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("bypasses cache after skipCache", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ books: [{ id: "demo" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await fetchJson("/books", {}, { fetchImpl });
    await fetchJson("/books", {}, { fetchImpl, skipCache: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
