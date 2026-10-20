import { describe, expect, it } from "vitest";
import { SIDEBAR_DESKTOP_WIDTH_CLASS } from "./sidebar-width";

describe("sidebar desktop width classes", () => {
  it("uses exclusive breakpoints so 240 cannot override 280 at ≥1680", () => {
    expect(SIDEBAR_DESKTOP_WIDTH_CLASS).toContain("xl:max-[1679px]:w-[240px]");
    expect(SIDEBAR_DESKTOP_WIDTH_CLASS).toContain("min-[1680px]:w-[280px]");
    expect(SIDEBAR_DESKTOP_WIDTH_CLASS).not.toMatch(/(^|\s)xl:w-\[240px\](\s|$)/);
  });
});
