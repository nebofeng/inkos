import { describe, expect, it } from "vitest";
import {
  COARSE_POINTER_QUERY,
  isCoarsePointer,
  isMobileViewport,
  MOBILE_QUERY,
  usesMobileSelectionChrome,
} from "./use-mobile";

function fakeWindow(matches: ReadonlyArray<string>): Pick<Window, "matchMedia"> {
  return {
    matchMedia: (query: string) => ({ matches: matches.includes(query) }) as MediaQueryList,
  };
}

describe("isMobileViewport", () => {
  it("uses the md breakpoint query", () => {
    expect(MOBILE_QUERY).toBe("(max-width: 767px)");
  });

  it("reports phone widths as mobile", () => {
    const seen: string[] = [];
    const win = { matchMedia: (query: string) => { seen.push(query); return { matches: true } as MediaQueryList; } };
    expect(isMobileViewport(win)).toBe(true);
    expect(seen).toEqual([MOBILE_QUERY]);
  });

  it("treats desktop and environments without matchMedia as desktop", () => {
    expect(isMobileViewport({ matchMedia: () => ({ matches: false }) as unknown as MediaQueryList })).toBe(false);
    expect(isMobileViewport(undefined)).toBe(false);
    expect(isMobileViewport({} as Pick<Window, "matchMedia">)).toBe(false);
  });
});

describe("usesMobileSelectionChrome", () => {
  it("uses the coarse pointer query", () => {
    expect(COARSE_POINTER_QUERY).toBe("(pointer: coarse)");
  });

  it("is true on phone width even with a fine pointer", () => {
    expect(usesMobileSelectionChrome(fakeWindow([MOBILE_QUERY]))).toBe(true);
    expect(isCoarsePointer(fakeWindow([MOBILE_QUERY]))).toBe(false);
  });

  it("is true on a coarse pointer even when the WebView reports a desktop width", () => {
    expect(usesMobileSelectionChrome(fakeWindow([COARSE_POINTER_QUERY]))).toBe(true);
  });

  it("is false on desktop fine-pointer", () => {
    expect(usesMobileSelectionChrome(fakeWindow([]))).toBe(false);
    expect(usesMobileSelectionChrome(undefined)).toBe(false);
  });
});
