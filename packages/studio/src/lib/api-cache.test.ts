import { afterEach, describe, expect, it } from "vitest";
import {
  DETAIL_TTL_MS,
  LIST_TTL_MS,
  invalidateApiCache,
  matchesCacheInvalidation,
  readApiCache,
  resetApiCacheForTests,
  ttlForApiUrl,
  writeApiCache,
} from "./api-cache";

afterEach(() => {
  resetApiCacheForTests();
});

describe("api cache", () => {
  it("uses shorter TTL for list endpoints", () => {
    expect(ttlForApiUrl("/api/v1/books")).toBe(LIST_TTL_MS);
    expect(ttlForApiUrl("/api/v1/books/demo")).toBe(DETAIL_TTL_MS);
    expect(ttlForApiUrl("/api/v1/books/demo/truth")).toBe(DETAIL_TTL_MS);
  });

  it("returns a stored value until invalidated", () => {
    writeApiCache("/api/v1/books", { books: [{ id: "demo" }] }, LIST_TTL_MS);
    expect(readApiCache("/api/v1/books")).toEqual({
      value: { books: [{ id: "demo" }] },
      fresh: true,
    });
    invalidateApiCache(["/api/v1/books"]);
    expect(readApiCache("/api/v1/books")).toBeNull();
  });

  it("invalidates nested book keys from a collection path", () => {
    expect(matchesCacheInvalidation("/api/v1/books/demo/chapters/1", ["/api/v1/books"])).toBe(true);
    expect(matchesCacheInvalidation("/api/v1/project", ["/api/v1/books"])).toBe(false);
  });
});
