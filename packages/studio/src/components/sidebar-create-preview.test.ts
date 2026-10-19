import { describe, expect, it } from "vitest";
import {
  CREATE_PREVIEW_CATEGORY_IDS,
  SIDEBAR_PREVIEW_LIMIT,
  buildCreatePreview,
  parseRecency,
  takeRecentPreview,
  type CreatePreviewItem,
} from "./sidebar-create-preview";

function book(id: string, updatedAt?: string, createdAt?: string): CreatePreviewItem {
  return { id, title: id, updatedAt, createdAt };
}

function short(id: string, batch?: string): CreatePreviewItem {
  return { id, title: id, batch };
}

describe("parseRecency", () => {
  it("parses ISO timestamps and date-like batches", () => {
    expect(parseRecency("2026-10-19T12:00:00.000Z")).toBe(Date.parse("2026-10-19T12:00:00.000Z"));
    expect(parseRecency("2026-10-13")).toBe(Date.parse("2026-10-13"));
    expect(parseRecency(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it("ignores empty or non-date values", () => {
    expect(parseRecency(undefined)).toBeUndefined();
    expect(parseRecency("")).toBeUndefined();
    expect(parseRecency("not-a-date")).toBeUndefined();
  });
});

describe("takeRecentPreview", () => {
  it("returns at most 5 most recent items", () => {
    const items = [
      book("a", "2026-01-01T00:00:00.000Z"),
      book("b", "2026-06-01T00:00:00.000Z"),
      book("c", "2026-03-01T00:00:00.000Z"),
      book("d", "2026-09-01T00:00:00.000Z"),
      book("e", "2026-02-01T00:00:00.000Z"),
      book("f", "2026-08-01T00:00:00.000Z"),
    ];
    expect(takeRecentPreview(items, (item) => parseRecency(item.updatedAt)).map((item) => item.id)).toEqual([
      "d",
      "f",
      "b",
      "c",
      "e",
    ]);
  });

  it("keeps original order when recency is missing and caps at the limit", () => {
    const items = ["1", "2", "3", "4", "5", "6"].map((id) => book(id));
    expect(takeRecentPreview(items, () => undefined).map((item) => item.id)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("returns the whole list when it is within the limit", () => {
    const items = [book("a"), book("b")];
    expect(takeRecentPreview(items, () => undefined)).toEqual(items);
  });
});

describe("buildCreatePreview", () => {
  it("exposes only category ids at the peer level (RD-041)", () => {
    const preview = buildCreatePreview({
      books: [book("alpha", "2026-10-01T00:00:00.000Z"), book("beta", "2026-10-02T00:00:00.000Z")],
      shorts: [short("s1", "2026-10-03")],
    });
    expect(preview.categoryIds).toEqual(["longform", "shorts"]);
    expect(preview.categoryIds).toEqual(CREATE_PREVIEW_CATEGORY_IDS);
    expect(preview.categoryIds).not.toContain("alpha");
    expect(preview.categoryIds).not.toContain("beta");
    expect(preview.categoryIds).not.toContain("s1");
  });

  it("puts recent books and shorts under their categories, not as peers (RD-040)", () => {
    const books = Array.from({ length: 7 }, (_, index) =>
      book(`book-${index}`, `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`),
    );
    const shorts = Array.from({ length: 6 }, (_, index) =>
      short(`short-${index}`, `2026-02-${String(index + 1).padStart(2, "0")}`),
    );
    const preview = buildCreatePreview({ books, shorts });

    expect(preview.longform.items.map((item) => item.id)).toEqual([
      "book-6",
      "book-5",
      "book-4",
      "book-3",
      "book-2",
    ]);
    expect(preview.longform.total).toBe(7);
    expect(preview.longform.hasMore).toBe(true);
    expect(preview.longform.items).toHaveLength(SIDEBAR_PREVIEW_LIMIT);

    expect(preview.shorts.items.map((item) => item.id)).toEqual([
      "short-5",
      "short-4",
      "short-3",
      "short-2",
      "short-1",
    ]);
    expect(preview.shorts.total).toBe(6);
    expect(preview.shorts.hasMore).toBe(true);
  });

  it("does not invent extra categories for empty libraries", () => {
    const preview = buildCreatePreview({ books: [], shorts: [] });
    expect(preview.categoryIds).toEqual(["longform", "shorts"]);
    expect(preview.longform.items).toEqual([]);
    expect(preview.shorts.items).toEqual([]);
    expect(preview.longform.hasMore).toBe(false);
    expect(preview.shorts.hasMore).toBe(false);
  });
});
