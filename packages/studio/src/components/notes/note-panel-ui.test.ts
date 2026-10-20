import { describe, expect, it } from "vitest";
import type { ChapterNote } from "../../lib/annotation-client";
import {
  APPLY_SUCCESS_TOAST,
  CANCEL_CONFIRM_BODY,
  CANCEL_CONFIRM_LABEL,
  CANCEL_CONFIRM_TITLE,
  CANCEL_CONTINUE_LABEL,
  OVERLAP_LABEL,
  acceptSelectedLabel,
  batchReviseLabel,
  canAcceptAllNotes,
  canAcceptSelectedNotes,
  cancelActionLabel,
  diffTokenClass,
  filterButtonLabel,
  formatProgressCopy,
  formatEstimateLabel,
  isReviewMode,
  notesToPatchSpans,
  openNoteIds,
  overlappingNoteIds,
  quotePreview,
} from "./note-panel-ui";

function note(partial: Partial<ChapterNote> & Pick<ChapterNote, "id" | "status">): ChapterNote {
  return {
    bookId: "demo",
    chapterNumber: 1,
    baseHash: "abc",
    selector: { exact: "门口的灯灭了。", prefix: "", suffix: "", start: 8, end: 16 },
    comment: "语气再冷",
    origin: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("note panel copy", () => {
  it("formats unified-revise progress without a fake percent", () => {
    const copy = formatProgressCopy({
      kind: "note_revise",
      estimateMs: 20_000,
      elapsedSeconds: 8,
    });
    expect(copy).toBe("正在统一修改… 预计约 20 秒 · 已用 00:08");
    expect(copy).not.toMatch(/\d+%/);
    expect(cancelActionLabel("note_revise")).toBe("取消");
  });

  it("formats full-chapter rewrite estimate as 6–7 minutes", () => {
    expect(formatEstimateLabel("chapter_rework", 390_000)).toBe("预计约 6–7 分钟");
    expect(formatEstimateLabel("chapter_rework")).toBe("预计约 6–7 分钟");
    const copy = formatProgressCopy({
      kind: "chapter_rework",
      estimateMs: 390_000,
      elapsedSeconds: 205,
    });
    expect(copy).toBe("AI 正在深度改写全章 预计约 6–7 分钟 · 已用 03:25");
    expect(cancelActionLabel("chapter_rework")).toBe("中止改写");
  });

  it("keeps abort confirmation copy from the design spec", () => {
    expect(CANCEL_CONFIRM_TITLE).toBe("确认中止本次 AI 生成？");
    expect(CANCEL_CONFIRM_BODY).toBe("未确认的内容将不会保存。");
    expect(CANCEL_CONTINUE_LABEL).toBe("继续生成");
    expect(CANCEL_CONFIRM_LABEL).toBe("确认中止");
    expect(APPLY_SUCCESS_TOAST).toBe("已全部合入，章节已保存为新版本");
    expect(OVERLAP_LABEL).toBe("区域重叠");
  });

  it("labels batch actions with counts", () => {
    expect(batchReviseLabel(3)).toBe("AI 统一修改 (3)");
    expect(acceptSelectedLabel(2)).toBe("通过所选 (2)");
    expect(acceptSelectedLabel(0)).toBe("通过所选");
    expect(filterButtonLabel("open", 3)).toBe("待处理 (3)");
    expect(filterButtonLabel("all", 5)).toBe("全部 (5)");
  });
});

describe("review selection", () => {
  const overlapping = [
    note({
      id: "a",
      status: "suggested",
      suggestion: { targetText: "门口的灯灭了。", replacementText: "门口的灯早就灭了。", start: 0, end: 8 },
    }),
    note({
      id: "b",
      status: "suggested",
      suggestion: { targetText: "灯灭了。", replacementText: "灯还亮着。", start: 6, end: 12 },
    }),
  ];
  const openAndSuggested = [
    note({ id: "open", status: "open" }),
    overlapping[0]!,
  ];

  it("enters review mode when any note is suggested", () => {
    expect(isReviewMode(openAndSuggested)).toBe(true);
    expect(isReviewMode([note({ id: "open", status: "open" })])).toBe(false);
    expect(openNoteIds(openAndSuggested)).toEqual(["open"]);
  });

  it("disables accept-all on overlapping patches but allows a single selected card", () => {
    expect(overlappingNoteIds(overlapping)).toEqual(["a", "b"]);
    expect(canAcceptAllNotes(overlapping)).toBe(false);
    expect(canAcceptSelectedNotes(overlapping, new Set(["a"]))).toBe(true);
    expect(canAcceptSelectedNotes(overlapping, new Set(["a", "b"]))).toBe(false);
    expect(canAcceptSelectedNotes(overlapping, new Set())).toBe(false);
    expect(notesToPatchSpans(overlapping)).toEqual([
      { noteId: "a", start: 0, end: 8 },
      { noteId: "b", start: 6, end: 12 },
    ]);
  });

  it("maps diff token types to red-delete / green-add classes", () => {
    expect(diffTokenClass("del")).toContain("bg-rose-100");
    expect(diffTokenClass("add")).toContain("bg-emerald-100");
    expect(quotePreview("门口的灯灭了。")).toBe("门口的灯灭了。");
    expect(quotePreview("x".repeat(90)).endsWith("…")).toBe(true);
  });
});
