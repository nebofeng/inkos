import { describe, expect, it } from "vitest";
import { COMPACT_QUERY, deriveStudioLayoutMode } from "./use-layout-mode";
import { MOBILE_QUERY } from "./use-mobile";

function fakeWindow(matches: ReadonlyArray<string>): Pick<Window, "matchMedia"> {
  return {
    matchMedia: (query: string) => ({ matches: matches.includes(query) }) as MediaQueryList,
  };
}

describe("deriveStudioLayoutMode", () => {
  it("uses the 1200px compact breakpoint", () => {
    expect(COMPACT_QUERY).toBe("(max-width: 1199px)");
  });

  it("treats phones as mobile", () => {
    expect(deriveStudioLayoutMode(fakeWindow([MOBILE_QUERY, COMPACT_QUERY]))).toBe("mobile");
  });

  it("treats 768–1199 as compact so Chat keeps ~580px", () => {
    expect(deriveStudioLayoutMode(fakeWindow([COMPACT_QUERY]))).toBe("compact");
  });

  it("treats ≥1200 as wide three-pane", () => {
    expect(deriveStudioLayoutMode(fakeWindow([]))).toBe("wide");
  });
});
