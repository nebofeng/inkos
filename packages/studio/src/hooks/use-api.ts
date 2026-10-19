import { useState, useEffect, useCallback } from "react";
import { localizeKnownRuntimeMessage } from "../lib/error-copy";
import {
  invalidateApiCache,
  matchesCacheInvalidation,
  readApiCache,
  shouldCacheRequest,
  ttlForApiUrl,
  writeApiCache,
} from "../lib/api-cache";
import { annotateHttpError } from "../lib/network-error";

const BASE = "/api/v1";
const API_INVALIDATE_EVENT = "inkos:api-invalidate";
export const BOOKS_COLLECTION_URL = "/api/v1/books";

interface ApiInvalidateDetail {
  readonly paths: ReadonlyArray<string>;
}

export function buildApiUrl(path: string): string | null {
  const normalized = String(path ?? "").trim();
  if (!normalized) return null;
  if (normalized.startsWith(`${BASE}/`) || normalized === BASE) {
    return normalized;
  }
  return normalized.startsWith("/") ? `${BASE}${normalized}` : `${BASE}/${normalized}`;
}

export function deriveInvalidationPaths(path: string): ReadonlyArray<string> {
  const normalized = buildApiUrl(path);
  if (!normalized) return [];

  if (
    normalized === "/api/v1/books/create"
    || normalized === "/api/v1/fanfic/init"
    || normalized === "/api/v1/spinoff/init"
    || normalized === "/api/v1/imitation/init"
  ) {
    return ["/api/v1/books"];
  }

  if (normalized === "/api/v1/project") {
    return ["/api/v1/project"];
  }

  if (normalized.startsWith("/api/v1/project/")) {
    return ["/api/v1/project", normalized];
  }

  if (normalized === "/api/v1/genres/create" || /^\/api\/v1\/genres(?:\/|$)/.test(normalized)) {
    return ["/api/v1/genres"];
  }

  // PUT/DELETE /books/:id and chapter writes (plan/compose/revise/resync/foundation/rewrite/…).
  const bookWrite = normalized.match(/^\/api\/v1\/books\/([^/]+)(?:\/|$)/);
  if (bookWrite && bookWrite[1] !== "create") {
    return ["/api/v1/books", `/api/v1/books/${bookWrite[1]}`];
  }

  if (/^\/api\/v1\/daemon\/(start|stop)$/.test(normalized)) {
    return ["/api/v1/daemon"];
  }

  return [];
}

export function invalidateApiPaths(paths: ReadonlyArray<string>): void {
  if (!paths.length) {
    return;
  }

  invalidateApiCache(paths);
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent<ApiInvalidateDetail>(API_INVALIDATE_EVENT, {
    detail: { paths: [...new Set(paths)] },
  }));
}

export function invalidateBooksCollection(): void {
  invalidateApiPaths([BOOKS_COLLECTION_URL]);
}

async function readErrorMessage(res: Response): Promise<string> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const json = await res.json() as { error?: unknown };
      if (typeof json.error === "string" && json.error.trim()) {
        return localizeKnownRuntimeMessage(json.error);
      }
      if (
        json.error
        && typeof json.error === "object"
        && "message" in json.error
        && typeof (json.error as { message?: unknown }).message === "string"
        && (json.error as { message: string }).message.trim()
      ) {
        return localizeKnownRuntimeMessage((json.error as { message: string }).message);
      }
    } catch {
      // fall through
    }
  }
  return localizeKnownRuntimeMessage(`${res.status} ${res.statusText}`.trim());
}

export async function fetchJson<T>(
  path: string,
  init: RequestInit = {},
  deps?: { readonly fetchImpl?: typeof fetch; readonly skipCache?: boolean },
): Promise<T> {
  const url = buildApiUrl(path);
  if (!url) {
    throw new Error("API path is required");
  }

  const useCache = !deps?.skipCache && shouldCacheRequest(init);
  if (useCache) {
    const cached = readApiCache<T>(url);
    if (cached?.fresh) {
      return cached.value;
    }
  }

  const fetchImpl = deps?.fetchImpl ?? fetch;
  // RD-045: dedupe concurrent GETs for the same url (reuse the pending promise).
  const dedupe = shouldCacheRequest(init);
  if (dedupe) {
    const pending = inflightGets.get(url);
    if (pending) return pending as Promise<T>;
    const promise = requestJson<T>(url, init, fetchImpl).finally(() => {
      inflightGets.delete(url);
    });
    inflightGets.set(url, promise);
    return promise;
  }
  return requestJson<T>(url, init, fetchImpl);
}

const inflightGets = new Map<string, Promise<unknown>>();

async function requestJson<T>(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(url, init);

  if (!res.ok) {
    throw new Error(annotateHttpError(res.status, await readErrorMessage(res)));
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const contentType = res.headers.get("content-type") ?? "";
  let json: T;
  if (!contentType.includes("application/json")) {
    const text = await res.text();
    if (!text.trim()) {
      json = undefined as T;
    } else {
      json = JSON.parse(text) as T;
    }
  } else {
    json = await res.json() as T;
  }

  if (shouldCacheRequest(init)) {
    writeApiCache(url, json, ttlForApiUrl(url));
  } else {
    invalidateApiPaths(deriveInvalidationPaths(url));
  }

  return json;
}

export function useApi<T>(path: string) {
  const initialUrl = buildApiUrl(path);
  const initialCache = initialUrl ? readApiCache<T>(initialUrl) : null;
  const [data, setData] = useState<T | null>(initialCache?.value ?? null);
  const [loading, setLoading] = useState(!initialCache);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async (opts?: { readonly force?: boolean }) => {
    const url = buildApiUrl(path);
    if (!url) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }

    const cached = readApiCache<T>(url);
    if (cached && !opts?.force) {
      setData(cached.value);
      if (cached.fresh) {
        setLoading(false);
        setError(null);
        return;
      }
      setLoading(false);
    } else if (!cached) {
      setLoading(true);
    }

    setError(null);
    try {
      const json = await fetchJson<T>(url, {}, { skipCache: opts?.force });
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    const url = buildApiUrl(path);
    if (!url || typeof window === "undefined") {
      return;
    }

    const handleInvalidate = (event: Event) => {
      const detail = (event as CustomEvent<ApiInvalidateDetail>).detail;
      if (!detail?.paths || !matchesCacheInvalidation(url, detail.paths)) {
        return;
      }
      void refetch({ force: true });
    };

    window.addEventListener(API_INVALIDATE_EVENT, handleInvalidate);
    return () => {
      window.removeEventListener(API_INVALIDATE_EVENT, handleInvalidate);
    };
  }, [path, refetch]);

  // RD-045: keep the returned refetch identity stable across renders so callers can
  // safely list it in effect deps (an unstable one caused a request storm).
  const forceRefetch = useCallback(() => refetch({ force: true }), [refetch]);

  return { data, loading, error, refetch: forceRefetch, mutate: setData };
}

export async function postApi<T>(path: string, body?: unknown): Promise<T> {
  const result = await fetchJson<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return result;
}

export async function putApi<T>(path: string, body?: unknown): Promise<T> {
  const result = await fetchJson<T>(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return result;
}
