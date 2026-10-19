import { describe, expect, it } from "vitest";
import { simulateChapterReaderVisible } from "../api/lib/annotation-selection";
import {
  canAcceptAllPatches,
  countNotesByFilter,
  filterNotes,
  formatElapsed,
  noteStatusBadge,
  overlappingPatchIds,
  paragraphSelectorAt,
  resolveAnnotationSelector,
  wordDiff,
  type NoteFilterItem,
} from "./note-panel-logic";

const SAMPLE = `# 夜雨

他没说话。

她低声说：“你**必须**走。”

> 「雨还在下。」

第二段里他没说话。门口的灯灭了。
`;

function note(partial: NoteFilterItem): NoteFilterItem {
  return partial;
}

describe("note filters and badges", () => {
  const notes = [
    note({ origin: "user", status: "open" }),
    note({ origin: "user", status: "suggested" }),
    note({ origin: "ai", status: "open" }),
    note({ origin: "user", status: "accepted" }),
    note({ origin: "ai", status: "orphaned" }),
    note({ origin: "user", status: "rejected" }),
  ];

  it("filters and counts 全部 / 我的建议 / 待处理 / 已改 / 失效", () => {
    expect(filterNotes(notes, "all")).toHaveLength(6);
    expect(filterNotes(notes, "mine")).toHaveLength(4);
    expect(filterNotes(notes, "open").every((item) => item.status === "open")).toBe(true);
    expect(filterNotes(notes, "suggested")).toEqual([{ origin: "user", status: "suggested" }]);
    expect(filterNotes(notes, "orphaned")).toEqual([{ origin: "ai", status: "orphaned" }]);
    expect(countNotesByFilter(notes)).toEqual({
      all: 6,
      mine: 4,
      open: 2,
      suggested: 1,
      orphaned: 1,
    });
  });

  it("maps status to Chinese badges", () => {
    expect(noteStatusBadge("open")).toBe("待处理");
    expect(noteStatusBadge("suggested")).toBe("已出建议");
    expect(noteStatusBadge("accepted")).toBe("已通过");
    expect(noteStatusBadge("rejected")).toBe("已忽略");
    expect(noteStatusBadge("orphaned")).toBe("原句已改动");
  });
});

describe("wordDiff", () => {
  it("diffs Chinese by character and merges adjacent tokens", () => {
    expect(wordDiff("门口的灯灭了", "门口的灯早就灭了")).toEqual([
      { type: "same", text: "门口的灯" },
      { type: "add", text: "早就" },
      { type: "same", text: "灭了" },
    ]);
  });

  it("marks deletions, additions, and identical text", () => {
    expect(wordDiff("hello world", "hello there world")).toEqual([
      { type: "same", text: "hello" },
      { type: "add", text: " there" },
      { type: "same", text: " world" },
    ]);
    expect(wordDiff("冷雨", "夜雨")).toEqual([
      { type: "del", text: "冷" },
      { type: "add", text: "夜" },
      { type: "same", text: "雨" },
    ]);
    expect(wordDiff("原句", "原句")).toEqual([{ type: "same", text: "原句" }]);
    expect(wordDiff("", "")).toEqual([]);
  });
});

describe("overlapping patches", () => {
  it("disables 全部通过 when ranges overlap, not when they only touch", () => {
    const overlapping = [
      { noteId: "a", start: 0, end: 8 },
      { noteId: "b", start: 6, end: 12 },
    ];
    expect(overlappingPatchIds(overlapping)).toEqual(["a", "b"]);
    expect(canAcceptAllPatches(overlapping)).toBe(false);

    const adjacent = [
      { noteId: "a", start: 0, end: 8 },
      { noteId: "b", start: 8, end: 12 },
    ];
    expect(overlappingPatchIds(adjacent)).toEqual([]);
    expect(canAcceptAllPatches(adjacent)).toBe(true);
  });
});

describe("formatElapsed", () => {
  it("formats seconds as mm:ss", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(8)).toBe("00:08");
    expect(formatElapsed(8.9)).toBe("00:08");
    expect(formatElapsed(125)).toBe("02:05");
    expect(formatElapsed(390)).toBe("06:30");
    expect(formatElapsed(-3)).toBe("00:00");
  });
});

describe("annotation selector fallback", () => {
  it("builds a quote selector from a unique source range", () => {
    const exact = "门口的灯灭了。";
    const start = SAMPLE.indexOf(exact);
    const resolved = resolveAnnotationSelector({
      source: SAMPLE,
      sourceStart: start,
      sourceEnd: start + exact.length,
    });
    expect(resolved?.usedParagraphFallback).toBe(false);
    expect(resolved?.selector.exact).toBe(exact);
    expect(resolved?.selector.start).toBe(start);
  });

  it("maps a ChapterReader visible selection back onto Markdown", () => {
    const index = simulateChapterReaderVisible(SAMPLE);
    const quote = "门口的灯灭了。";
    const visStart = index.visible.indexOf(quote);
    const resolved = resolveAnnotationSelector({
      source: SAMPLE,
      visibleStart: visStart,
      visibleEnd: visStart + quote.length,
      renderer: "chapter-reader",
    });
    expect(resolved?.usedParagraphFallback).toBe(false);
    expect(resolved?.selector.exact).toBe(quote);
  });

  it("falls back to the enclosing paragraph when the range is empty", () => {
    const offset = SAMPLE.indexOf("门口的灯灭了。");
    const resolved = resolveAnnotationSelector({
      source: SAMPLE,
      sourceStart: offset,
      sourceEnd: offset,
    });
    expect(resolved?.usedParagraphFallback).toBe(true);
    expect(resolved?.selector.exact).toContain("门口的灯灭了。");
    expect(resolved?.selector.exact).toContain("第二段里他没说话。");

    const explicit = paragraphSelectorAt(SAMPLE, offset);
    expect(explicit?.usedParagraphFallback).toBe(true);
    expect(explicit?.selector.exact).toBe(resolved?.selector.exact);
  });
});
