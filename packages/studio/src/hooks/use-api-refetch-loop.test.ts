import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, useState } from "react";
import { renderToString } from "react-dom/server";
import { resetApiCacheForTests } from "../lib/api-cache";
import { fetchJson, useApi } from "./use-api";

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
