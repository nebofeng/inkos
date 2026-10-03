import { describe, expect, it } from "vitest";
import { isMobileViewport, MOBILE_QUERY } from "./use-mobile";

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
