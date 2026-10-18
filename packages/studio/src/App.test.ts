import { describe, expect, it } from "vitest";
import { deriveActiveBookId, deriveHeaderCrumb, deriveStartupGate, isBookCreateChatRoute } from "./App";

describe("deriveActiveBookId", () => {
  it("returns the current book across book-centered routes", () => {
    expect(deriveActiveBookId({ page: "book", bookId: "alpha" })).toBe("alpha");
    expect(deriveActiveBookId({ page: "chapter", bookId: "beta", chapterNumber: 3 })).toBe("beta");
    expect(deriveActiveBookId({ page: "truth", bookId: "gamma" })).toBe("gamma");
    expect(deriveActiveBookId({ page: "analytics", bookId: "delta" })).toBe("delta");
    expect(deriveActiveBookId({ page: "book-settings", bookId: "epsilon" })).toBe("epsilon");
  });

  it("returns undefined for non-book routes", () => {
    expect(deriveActiveBookId({ page: "dashboard" })).toBeUndefined();
    expect(deriveActiveBookId({ page: "services" })).toBeUndefined();
    expect(deriveActiveBookId({ page: "style" })).toBeUndefined();
  });
});

describe("deriveHeaderCrumb", () => {
  it("keeps the product name off book routes", () => {
    expect(deriveHeaderCrumb({ bookId: undefined, bookTitle: "ignored" })).toBe("InkOS Studio");
  });

  it("shows the current book title on book routes", () => {
    expect(deriveHeaderCrumb({ bookId: "smoke-book", bookTitle: "书A-冒烟测试书" })).toBe("书A-冒烟测试书");
  });

  it("falls back to the book id before title loads", () => {
    expect(deriveHeaderCrumb({ bookId: "smoke-book", bookTitle: undefined })).toBe("smoke-book");
    expect(deriveHeaderCrumb({ bookId: "smoke-book", bookTitle: "   " })).toBe("smoke-book");
  });
});

describe("isBookCreateChatRoute", () => {
  it("routes new-book creation through chat instead of the standalone form page", () => {
    expect(isBookCreateChatRoute({ page: "book-create" })).toBe(true);
    expect(isBookCreateChatRoute({ page: "book", bookId: "alpha" })).toBe(false);
  });
});

describe("deriveStartupGate", () => {
  it("shows startup errors instead of spinning forever before the project is ready", () => {
    expect(deriveStartupGate({ ready: false, projectError: null })).toBe("loading");
    expect(deriveStartupGate({ ready: false, projectError: "bad inkos.json" })).toBe("error");
    expect(deriveStartupGate({ ready: true, projectError: "later refetch failed" })).toBe("ready");
  });
});
