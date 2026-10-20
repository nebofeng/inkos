import { describe, expect, it } from "vitest";
import { simulateChapterReaderVisible } from "../api/lib/annotation-selection";
import type { ChapterNote } from "../lib/annotation-client";
import {
  HIGHLIGHT_CLASS,
  NOTE_ANCHOR_SCROLL_MARGIN_CLASS,
  PARAGRAPH_FALLBACK_TOAST,
  RIGHT_RAIL_WIDTH_CLASS,
  highlightsFromNotes,
  noteAnchorId,
  paragraphVisibleRanges,
  railNotesLabel,
  sourceRangeToVisible,
  splitHighlightedText,
} from "./chapter-reader-notes";

const SAMPLE = `# 夜雨

他没说话。

门口的灯灭了。
`;

function note(partial: Partial<ChapterNote> & Pick<ChapterNote, "id" | "status">): ChapterNote {
  return {
    bookId: "demo",
    chapterNumber: 1,
    baseHash: "abc",
    selector: { exact: "门口的灯灭了。", prefix: "", suffix: "", start: 0, end: 1 },
    comment: "语气再冷",
    origin: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("chapter reader notes chrome", () => {
  it("labels the notes tab with a count", () => {
    expect(railNotesLabel(0)).toBe("备注 (0)");
    expect(railNotesLabel(3)).toBe("备注 (3)");
  });

  it("keeps design.md underline tokens and 96px scroll margin", () => {
    expect(HIGHLIGHT_CLASS.open).toContain("border-dashed");
    expect(HIGHLIGHT_CLASS.suggested).toContain("border-indigo-500");
    expect(HIGHLIGHT_CLASS.orphaned).toContain("border-dotted");
    expect(NOTE_ANCHOR_SCROLL_MARGIN_CLASS).toBe("scroll-mt-24");
    expect(RIGHT_RAIL_WIDTH_CLASS).toBe("w-[340px]");
    expect(PARAGRAPH_FALLBACK_TOAST).toBe("已按段落添加备注");
    expect(noteAnchorId("n1")).toBe("note-anchor-n1");
  });
});

describe("visible mapping", () => {
  it("joins paragraphs with a newline like ChapterReader", () => {
    expect(paragraphVisibleRanges(["他没说话。", "门口的灯灭了。"])).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 13 },
    ]);
  });

  it("maps a source quote onto visible offsets and splits the paragraph", () => {
    const index = simulateChapterReaderVisible(SAMPLE);
    const exact = "门口的灯灭了。";
    const start = SAMPLE.indexOf(exact);
    const visible = sourceRangeToVisible(index, start, start + exact.length);
    expect(index.visible.slice(visible!.start, visible!.end)).toBe(exact);

    const highlights = highlightsFromNotes(
      [note({
        id: "n1",
        status: "open",
        selector: { exact, prefix: "", suffix: "", start, end: start + exact.length },
      })],
      index,
    );
    expect(highlights).toEqual([{ noteId: "n1", status: "open", start: visible!.start, end: visible!.end }]);

    const ranges = paragraphVisibleRanges(["他没说话。", exact]);
    const segments = splitHighlightedText(exact, ranges[1]!.start, highlights);
    expect(segments).toEqual([
      { text: exact, noteId: "n1", status: "open", anchor: true },
    ]);
  });

  it("ignores accepted notes and skips ranges that cannot be located", () => {
    const index = simulateChapterReaderVisible(SAMPLE);
    const highlights = highlightsFromNotes(
      [
        note({ id: "ok", status: "accepted", selector: { exact: "x", prefix: "", suffix: "", start: 0, end: 2 } }),
        note({ id: "miss", status: "open", selector: { exact: "gone", prefix: "", suffix: "", start: 999, end: 1003 } }),
      ],
      index,
    );
    expect(highlights).toEqual([]);
  });
});
