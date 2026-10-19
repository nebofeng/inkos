import { describe, expect, it } from "vitest";
import {
  ADD_NOTE_LABEL,
  ASK_AI_LABEL,
  DESKTOP_FLOATING_BAR_CLASS,
  FLOATING_BAR_GAP_PX,
  MOBILE_ADD_NOTE_LABEL,
  MOBILE_NOTE_SHEET_BODY_CLASS,
  MOBILE_NOTE_SHEET_CLASS,
  MOBILE_SELECTION_CAPSULE_CLASS,
  SAVE_LABEL,
  floatingBarPosition,
  keyboardOverlapPx,
} from "./selection-ui";

describe("selection chrome copy", () => {
  it("uses design.md labels", () => {
    expect(ADD_NOTE_LABEL).toBe("加备注");
    expect(ASK_AI_LABEL).toBe("问 AI");
    expect(SAVE_LABEL).toBe("保存");
    expect(MOBILE_ADD_NOTE_LABEL).toBe("✍️ 加备注");
  });
});

describe("selection chrome classes", () => {
  it("keeps the desktop dark capsule tokens", () => {
    for (const token of ["z-30", "rounded-lg", "bg-zinc-900", "px-1.5", "py-1", "text-white", "shadow-xl", "-translate-x-1/2"]) {
      expect(DESKTOP_FLOATING_BAR_CLASS).toContain(token);
    }
  });

  it("keeps the 44px bottom-center mobile capsule tokens", () => {
    for (const token of ["fixed", "bottom-6", "left-1/2", "z-40", "h-11", "rounded-full", "bg-zinc-900", "px-5", "py-2.5"]) {
      expect(MOBILE_SELECTION_CAPSULE_CLASS).toContain(token);
    }
  });

  it("locks the sheet to 50vh with overscroll contain and safe-area padding", () => {
    expect(MOBILE_NOTE_SHEET_CLASS).toContain("h-[50vh]");
    expect(MOBILE_NOTE_SHEET_CLASS).toContain("pb-[env(safe-area-inset-bottom)]");
    expect(MOBILE_NOTE_SHEET_BODY_CLASS).toContain("overscroll-contain");
  });
});

describe("floatingBarPosition", () => {
  it("centers 8px above the selection rect", () => {
    expect(FLOATING_BAR_GAP_PX).toBe(8);
    expect(floatingBarPosition({ top: 120, left: 10, width: 40 })).toEqual({ left: 30, top: 112 });
  });
});

describe("keyboardOverlapPx", () => {
  it("measures the occluded viewport without inventing a percent", () => {
    expect(keyboardOverlapPx({ innerHeight: 800 }, { height: 500, offsetTop: 0 })).toBe(300);
    expect(keyboardOverlapPx({ innerHeight: 800 }, { height: 800, offsetTop: 0 })).toBe(0);
    expect(keyboardOverlapPx({ innerHeight: 800 }, null)).toBe(0);
  });
});
