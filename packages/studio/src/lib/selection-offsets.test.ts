import { describe, expect, it } from "vitest";
import {
  caretToVisibleOffset,
  concatVisibleText,
  firstUsableClientRect,
  isUsableSelectionRect,
  isUsableSelectionText,
  rangeClientRect,
  visibleOffsetsFromCarets,
  visibleOffsetsFromRange,
  type TextSlice,
} from "./selection-offsets";

const SLICES: TextSlice[] = [
  { text: "他没说话。" },
  { text: "她低声说：" },
  { text: "你必须走。" },
];

describe("visible text concatenation", () => {
  it("joins slices in document order", () => {
    expect(concatVisibleText(SLICES)).toBe("他没说话。她低声说：你必须走。");
    expect(concatVisibleText([])).toBe("");
  });
});

describe("caretToVisibleOffset", () => {
  it("counts UTF-16 offsets across preceding slices", () => {
    expect(caretToVisibleOffset(SLICES, { sliceIndex: 0, offset: 0 })).toBe(0);
    expect(caretToVisibleOffset(SLICES, { sliceIndex: 0, offset: 5 })).toBe(5);
    expect(caretToVisibleOffset(SLICES, { sliceIndex: 1, offset: 0 })).toBe(5);
    expect(caretToVisibleOffset(SLICES, { sliceIndex: 2, offset: 2 })).toBe(12);
  });

  it("rejects out-of-range carets", () => {
    expect(caretToVisibleOffset(SLICES, { sliceIndex: -1, offset: 0 })).toBeNull();
    expect(caretToVisibleOffset(SLICES, { sliceIndex: 3, offset: 0 })).toBeNull();
    expect(caretToVisibleOffset(SLICES, { sliceIndex: 0, offset: 6 })).toBeNull();
    expect(caretToVisibleOffset(SLICES, { sliceIndex: 0, offset: -1 })).toBeNull();
  });
});

describe("visibleOffsetsFromCarets", () => {
  it("maps a multi-slice range to container offsets", () => {
    const result = visibleOffsetsFromCarets(
      SLICES,
      { sliceIndex: 0, offset: 3 },
      { sliceIndex: 1, offset: 2 },
    );
    expect(result).toEqual({
      start: 3,
      end: 7,
      text: "话。她低",
    });
  });

  it("normalizes inverted carets", () => {
    const result = visibleOffsetsFromCarets(
      SLICES,
      { sliceIndex: 2, offset: 5 },
      { sliceIndex: 2, offset: 1 },
    );
    expect(result).toEqual({
      start: 11,
      end: 15,
      text: "必须走。",
    });
  });

  it("returns null for collapsed or whitespace-only ranges", () => {
    expect(
      visibleOffsetsFromCarets(SLICES, { sliceIndex: 1, offset: 2 }, { sliceIndex: 1, offset: 2 }),
    ).toBeNull();
    expect(
      visibleOffsetsFromCarets(
        [{ text: "  \n  " }],
        { sliceIndex: 0, offset: 0 },
        { sliceIndex: 0, offset: 5 },
      ),
    ).toBeNull();
  });

  it("returns null when either caret is invalid", () => {
    expect(
      visibleOffsetsFromCarets(SLICES, { sliceIndex: 0, offset: 0 }, { sliceIndex: 9, offset: 0 }),
    ).toBeNull();
  });
});

describe("isUsableSelectionText", () => {
  it("requires non-whitespace text", () => {
    expect(isUsableSelectionText("门口的灯灭了。")).toBe(true);
    expect(isUsableSelectionText("  \t")).toBe(false);
    expect(isUsableSelectionText("")).toBe(false);
  });
});

describe("visibleOffsetsFromRange", () => {
  it("returns null when the range is outside the container", () => {
    const container = { contains: () => false, ownerDocument: null } as unknown as Node;
    const range = {
      startContainer: {} as Node,
      startOffset: 0,
      endContainer: {} as Node,
      endOffset: 1,
    } as AbstractRange;
    expect(visibleOffsetsFromRange(container, range)).toBeNull();
  });
});

describe("rangeClientRect", () => {
  it("rejects a zero-size rect so desktop chrome can wait for a real box", () => {
    expect(isUsableSelectionRect({ width: 0, height: 0 })).toBe(false);
    expect(isUsableSelectionRect({ width: 12, height: 0 })).toBe(false);
    expect(isUsableSelectionRect({ width: 12, height: 18 })).toBe(true);
    const empty = {
      getClientRects: () => [],
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
    } as unknown as Range;
    expect(rangeClientRect(empty)).toBeNull();
  });

  it("skips a zero-width ::first-letter leftover and uses the next box", () => {
    const dropCapThenText = {
      getClientRects: () => [
        { top: 400, left: 216, width: 0, height: 25, bottom: 425, right: 216 },
        { top: 400, left: 216, width: 171, height: 25, bottom: 425, right: 387 },
      ],
      getBoundingClientRect: () => ({ top: 400, left: 216, width: 171, height: 25, bottom: 425, right: 387 }),
    } as unknown as Range;
    expect(rangeClientRect(dropCapThenText)).toEqual({
      top: 400,
      left: 216,
      width: 171,
      height: 25,
      bottom: 425,
      right: 387,
    });
    expect(
      firstUsableClientRect([
        { top: 0, left: 0, width: 0, height: 24, bottom: 24, right: 0 },
        { top: 12, left: 40, width: 80, height: 24, bottom: 36, right: 120 },
      ]),
    ).toMatchObject({ left: 40, width: 80 });
  });
});
