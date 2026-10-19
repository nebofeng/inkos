import { describe, expect, it } from "vitest";
import { collectionListStatus } from "./sidebar-collection-status";

describe("collectionListStatus", () => {
  it("shows error instead of empty when the request failed", () => {
    expect(collectionListStatus("Failed to fetch", 0)).toBe("error");
    expect(collectionListStatus("Failed to fetch", 3)).toBe("error");
  });

  it("shows empty only after a successful empty payload", () => {
    expect(collectionListStatus(null, 0)).toBe("empty");
    expect(collectionListStatus(undefined, 0)).toBe("empty");
  });

  it("shows ready when items exist", () => {
    expect(collectionListStatus(null, 2)).toBe("ready");
  });
});
