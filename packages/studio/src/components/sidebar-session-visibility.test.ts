import { describe, expect, it } from "vitest";
import { shouldShowBookSessionEntry } from "./sidebar-session-visibility";

describe("shouldShowBookSessionEntry", () => {
  it("hides the current book's session list on the book workspace page", () => {
    expect(shouldShowBookSessionEntry("smoke-book", "smoke-book")).toBe(false);
  });

  it("keeps other books' session entries on the book workspace page", () => {
    expect(shouldShowBookSessionEntry("smoke-book", "demo")).toBe(true);
  });

  it("keeps every book's session entry on other pages", () => {
    expect(shouldShowBookSessionEntry(undefined, "smoke-book")).toBe(true);
  });
});
