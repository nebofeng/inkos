export const API_CACHE_STORAGE_PREFIX = "inkos:api-cache:";
export const LIST_TTL_MS = 60_000;
export const DETAIL_TTL_MS = 120_000;

interface CacheEntry<T = unknown> {
  readonly value: T;
  readonly storedAt: number;
  readonly ttlMs: number;
}

const memoryCache = new Map<string, CacheEntry>();

function now(): number {
  return Date.now();
}

export function ttlForApiUrl(url: string): number {
  if (
    url === "/api/v1/books"
    || url === "/api/v1/interactive-films"
    || url === "/api/v1/daemon"
    || url === "/api/v1/genres"
    || url === "/api/v1/project"
  ) {
    return LIST_TTL_MS;
  }
  return DETAIL_TTL_MS;
}

export function isCacheFresh(entry: CacheEntry, at = now()): boolean {
  return at - entry.storedAt < entry.ttlMs;
}

function readSessionStorage(key: string): CacheEntry | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(`${API_CACHE_STORAGE_PREFIX}${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry;
    if (!parsed || typeof parsed.storedAt !== "number" || typeof parsed.ttlMs !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeSessionStorage(key: string, entry: CacheEntry): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(`${API_CACHE_STORAGE_PREFIX}${key}`, JSON.stringify(entry));
  } catch {
    // quota / private mode — memory cache still works
  }
}

function removeSessionStorage(key: string): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(`${API_CACHE_STORAGE_PREFIX}${key}`);
  } catch {
    // ignore
  }
}

export function readApiCache<T>(key: string): { value: T; fresh: boolean } | null {
  const memory = memoryCache.get(key) as CacheEntry<T> | undefined;
  if (memory) {
    return { value: memory.value, fresh: isCacheFresh(memory) };
  }
  const stored = readSessionStorage(key) as CacheEntry<T> | null;
  if (!stored) return null;
  memoryCache.set(key, stored);
  return { value: stored.value, fresh: isCacheFresh(stored) };
}

export function writeApiCache<T>(key: string, value: T, ttlMs = ttlForApiUrl(key)): void {
  const entry: CacheEntry<T> = { value, storedAt: now(), ttlMs };
  memoryCache.set(key, entry);
  writeSessionStorage(key, entry);
}

export function dropApiCache(key: string): void {
  memoryCache.delete(key);
  removeSessionStorage(key);
}

export function matchesCacheInvalidation(cachedUrl: string, paths: ReadonlyArray<string>): boolean {
  return paths.some((path) => cachedUrl === path || cachedUrl.startsWith(`${path}/`));
}

export function invalidateApiCache(paths: ReadonlyArray<string>): void {
  if (paths.length === 0) return;
  for (const key of [...memoryCache.keys()]) {
    if (matchesCacheInvalidation(key, paths)) {
      dropApiCache(key);
    }
  }
  if (typeof sessionStorage === "undefined") return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const storageKey = sessionStorage.key(i);
      if (!storageKey?.startsWith(API_CACHE_STORAGE_PREFIX)) continue;
      const url = storageKey.slice(API_CACHE_STORAGE_PREFIX.length);
      if (matchesCacheInvalidation(url, paths)) toRemove.push(url);
    }
    for (const url of toRemove) dropApiCache(url);
  } catch {
    // ignore
  }
}

export function resetApiCacheForTests(): void {
  memoryCache.clear();
  if (typeof sessionStorage === "undefined") return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const storageKey = sessionStorage.key(i);
      if (storageKey?.startsWith(API_CACHE_STORAGE_PREFIX)) toRemove.push(storageKey);
    }
    for (const storageKey of toRemove) sessionStorage.removeItem(storageKey);
  } catch {
    // ignore
  }
}

export function shouldCacheRequest(init: RequestInit = {}): boolean {
  const method = (init.method ?? "GET").toUpperCase();
  return method === "GET" && init.body == null;
}
