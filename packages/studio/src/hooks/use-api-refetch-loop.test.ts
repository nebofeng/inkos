import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, useState } from "react";
import { renderToString } from "react-dom/server";
import { LIST_TTL_MS, matchesCacheInvalidation, readApiCache, resetApiCacheForTests, writeApiCache } from "../lib/api-cache";
import { BOOKS_COLLECTION_URL, fetchJson, invalidateBooksCollection, useApi } from "./use-api";
import { MAX_NETWORK_RETRIES, planApiRetry, planNetworkRetry, resetBackoffRetriesOn } from "../lib/network-error";
import { collectionListStatus } from "../components/sidebar-collection-status";

afterEach(() => {
  resetApiCacheForTests();
});

describe("RD-045 refetch loop guards", () => {
  it("keeps useApi().refetch identity stable across re-renders", () => {
    const seen: Array<unknown> = [];
    function Probe() {
      const { refetch } = useApi<unknown>("");
      const [n, setN] = useState(0);
      seen.push(refetch);
      if (n < 2) setN(n + 1); // render-phase update forces re-render with preserved hooks
      return null;
    }
    renderToString(createElement(Probe));
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(new Set(seen).size).toBe(1);
  });

  it("dedupes concurrent GETs for the same path", async () => {
    let resolve!: (r: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => { resolve = r; }));
    const a = fetchJson<{ ok: boolean }>("/books", {}, { fetchImpl, skipCache: true });
    const b = fetchJson<{ ok: boolean }>("/books", {}, { fetchImpl, skipCache: true });
    resolve(new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } }));
    await expect(a).resolves.toEqual({ ok: true });
    await expect(b).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const c = fetchJson<{ ok: boolean }>("/books", {}, { fetchImpl: vi.fn(async () => new Response(JSON.stringify({ ok: 2 }), { headers: { "Content-Type": "application/json" } })), skipCache: true });
    await expect(c).resolves.toEqual({ ok: 2 });
  });
});

describe("RD-046 sidebar collection recovery", () => {
  it("does not treat a failed /books request as an empty library", () => {
    expect(collectionListStatus("Failed to fetch", 0)).toBe("error");
    expect(collectionListStatus("500 Internal Server Error", 0)).toBe("error");
    expect(collectionListStatus(null, 0)).toBe("empty");
    expect(collectionListStatus(null, 2)).toBe("ready");
  });

  it("caps automatic network retries at 3 and never schedules a 4th", () => {
    const scheduled: number[] = [];
    for (let retries = 0; retries < 8; retries += 1) {
      const plan = planNetworkRetry(true, retries);
      if (plan) scheduled.push(retries);
    }
    expect(scheduled).toEqual([0, 1, 2]);
    expect(scheduled).toHaveLength(MAX_NETWORK_RETRIES);
    expect(planNetworkRetry(true, MAX_NETWORK_RETRIES)).toBeNull();
    expect(planNetworkRetry(false, 0)).toBeNull();
  });

  it("retries HTTP 5xx with the same cap of 3 and does not retry 4xx", () => {
    const scheduled5xx: number[] = [];
    for (let retries = 0; retries < 8; retries += 1) {
      const plan = planApiRetry("500 Internal Server Error", retries);
      if (plan) scheduled5xx.push(retries);
    }
    expect(scheduled5xx).toEqual([0, 1, 2]);
    expect(planApiRetry("400 Bad request", 0)).toBeNull();
    expect(planApiRetry("404 Not Found", 1)).toBeNull();
  });

  it("resets the backoff count after success so a later 5xx can retry again", () => {
    let retries = MAX_NETWORK_RETRIES;
    expect(planApiRetry("502 Bad Gateway", retries)).toBeNull();
    retries = resetBackoffRetriesOn("success") ?? retries;
    expect(retries).toBe(0);
    expect(planApiRetry("502 Bad Gateway", retries)).toEqual({ delayMs: 1000 });
  });
});

describe("RD-046 dashboard/sidebar books sync", () => {
  it("invalidating the books collection drops the shared cache used by dashboard", () => {
    writeApiCache(BOOKS_COLLECTION_URL, { books: [] }, LIST_TTL_MS);
    expect(readApiCache(BOOKS_COLLECTION_URL)?.value).toEqual({ books: [] });
    invalidateBooksCollection();
    expect(readApiCache(BOOKS_COLLECTION_URL)).toBeNull();
  });

  it("sidebar books retry notifies every /api/v1/books subscriber including dashboard", () => {
    const paths = [BOOKS_COLLECTION_URL];
    expect(matchesCacheInvalidation("/api/v1/books", paths)).toBe(true);
    expect(matchesCacheInvalidation("/api/v1/books/demo", paths)).toBe(true);
    expect(matchesCacheInvalidation("/api/v1/shorts", paths)).toBe(false);
    expect(matchesCacheInvalidation("/api/v1/interactive-films", paths)).toBe(false);
  });
});
