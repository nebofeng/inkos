import { describe, expect, it } from "vitest";
import { adjacentChapters } from "./ChapterReader";

describe("adjacentChapters", () => {
  it("finds existing neighbours, skipping gaps", () => {
    const chapters = [{ number: 3 }, { number: 1 }, { number: 5 }];
    expect(adjacentChapters(chapters, 3)).toEqual({ prev: 1, next: 5 });
    expect(adjacentChapters(chapters, 1)).toEqual({ prev: null, next: 3 });
    expect(adjacentChapters(chapters, 5)).toEqual({ prev: 3, next: null });
  });

  it("falls back to n-1 while the chapter list is loading", () => {
    expect(adjacentChapters(undefined, 4)).toEqual({ prev: 3, next: null });
    expect(adjacentChapters([], 1)).toEqual({ prev: null, next: null });
  });
});
