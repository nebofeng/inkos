/**
 * Copy, filters, and review-mode helpers for the notes rail components.
 */

import type { AnnotationStatus, ChapterNote } from "../../lib/annotation-client";
import {
  NOTE_FILTER_KEYS,
  NOTE_FILTER_LABELS,
  canAcceptAllPatches,
  formatElapsed,
  overlappingPatchIds,
  type NoteFilterKey,
  type PatchSpan,
} from "../../lib/note-panel-logic";

export { NOTE_FILTER_KEYS, NOTE_FILTER_LABELS, formatElapsed };
export type { NoteFilterKey };

export type TaskProgressKind = "note_revise" | "chapter_rework" | "short_assist";

export const TAP_TARGET_CLASS = "min-h-11 min-w-11 md:min-h-8 md:min-w-8";

export const CARD_BASE_CLASS =
  "group rounded-xl border border-zinc-200/80 bg-white p-3.5 shadow-xs hover:border-zinc-300 transition-all scroll-mt-24";

export const DIFF_DELETION_CLASS =
  "bg-rose-100 text-rose-800 line-through decoration-rose-400 px-1 py-0.5 rounded text-sm";

export const DIFF_ADDITION_CLASS =
  "bg-emerald-100 text-emerald-800 underline decoration-emerald-400 px-1 py-0.5 rounded text-sm font-medium";

export const DIFF_SAME_CLASS = "text-sm text-zinc-700";

export const PROGRESS_BANNER_CLASS =
  "rounded-xl border border-indigo-100 bg-indigo-50/70 p-3 text-xs text-indigo-950";

export const PROGRESS_BAR_TRACK_CLASS =
  "relative mt-2 h-1.5 w-full overflow-hidden rounded-full bg-indigo-200/60";

export const OVERLAP_LABEL = "区域重叠";
export const APPLY_SUCCESS_TOAST = "已全部合入，章节已保存为新版本";
export const CANCELLED_TOAST = "已中止改写，正文未作改动";
export const DELETE_TOAST = "已删除备注";
export const UNDO_LABEL = "撤销";
export const CANCEL_CONFIRM_TITLE = "确认中止本次 AI 生成？";
export const CANCEL_CONFIRM_BODY = "未确认的内容将不会保存。";
export const CANCEL_CONTINUE_LABEL = "继续生成";
export const CANCEL_CONFIRM_LABEL = "确认中止";
export const NOTE_REVISE_DEFAULT_MS = 20_000;
export const CHAPTER_REWORK_DEFAULT_LABEL = "预计约 6–7 分钟";

const STATUS_BADGE_CLASS: Record<AnnotationStatus, string> = {
  open: "bg-amber-100 text-amber-800 border-transparent",
  suggested: "bg-indigo-100 text-indigo-800 border-transparent",
  accepted: "bg-emerald-100 text-emerald-800 border-transparent",
  rejected: "bg-zinc-100 text-zinc-500 border-transparent",
  orphaned: "bg-zinc-100 text-zinc-400 border-transparent",
};

export function statusBadgeClass(status: AnnotationStatus): string {
  return STATUS_BADGE_CLASS[status];
}

export function diffTokenClass(type: "same" | "del" | "add"): string {
  if (type === "del") return DIFF_DELETION_CLASS;
  if (type === "add") return DIFF_ADDITION_CLASS;
  return DIFF_SAME_CLASS;
}

export function notesToPatchSpans(notes: ReadonlyArray<ChapterNote>): PatchSpan[] {
  const spans: PatchSpan[] = [];
  for (const note of notes) {
    if (note.status !== "suggested" || !note.suggestion) continue;
    spans.push({
      noteId: note.id,
      start: note.suggestion.start,
      end: note.suggestion.end,
    });
  }
  return spans;
}

export function overlappingNoteIds(notes: ReadonlyArray<ChapterNote>): string[] {
  return overlappingPatchIds(notesToPatchSpans(notes));
}

export function isReviewMode(notes: ReadonlyArray<Pick<ChapterNote, "status">>): boolean {
  return notes.some((note) => note.status === "suggested");
}

export function openNoteIds(notes: ReadonlyArray<Pick<ChapterNote, "id" | "status">>): string[] {
  return notes.filter((note) => note.status === "open").map((note) => note.id);
}

export function suggestedNotes(notes: ReadonlyArray<ChapterNote>): ChapterNote[] {
  return notes.filter((note) => note.status === "suggested" && Boolean(note.suggestion));
}

export function canAcceptAllNotes(notes: ReadonlyArray<ChapterNote>): boolean {
  const suggested = suggestedNotes(notes);
  return suggested.length > 0 && canAcceptAllPatches(notesToPatchSpans(suggested));
}

export function canAcceptSelectedNotes(
  notes: ReadonlyArray<ChapterNote>,
  selectedIds: ReadonlySet<string>,
): boolean {
  const chosen = suggestedNotes(notes).filter((note) => selectedIds.has(note.id));
  return chosen.length > 0 && canAcceptAllPatches(notesToPatchSpans(chosen));
}

export function filterButtonLabel(key: NoteFilterKey, count: number): string {
  return `${NOTE_FILTER_LABELS[key]} (${count})`;
}

export function formatEstimateLabel(kind: TaskProgressKind, estimateMs?: number): string {
  if (kind === "chapter_rework") {
    if (!estimateMs || estimateMs <= 0) return CHAPTER_REWORK_DEFAULT_LABEL;
    const minutes = estimateMs / 60_000;
    const lo = Math.max(1, Math.floor(minutes));
    const hi = Math.max(lo + 1, Math.ceil(minutes));
    return `预计约 ${lo}–${hi} 分钟`;
  }
  const ms = !estimateMs || estimateMs <= 0 ? NOTE_REVISE_DEFAULT_MS : estimateMs;
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `预计约 ${seconds} 秒`;
}

export function progressHeadline(kind: TaskProgressKind, cancelling = false): string {
  if (cancelling) return "正在中止…";
  if (kind === "chapter_rework") return "AI 正在深度改写全章";
  if (kind === "short_assist") return "正在改写…";
  return "正在统一修改…";
}

export function cancelActionLabel(kind: TaskProgressKind): string {
  return kind === "chapter_rework" ? "中止改写" : "取消";
}

export function formatProgressCopy(input: {
  readonly kind: TaskProgressKind;
  readonly estimateMs?: number;
  readonly elapsedSeconds: number;
  readonly cancelling?: boolean;
}): string {
  const headline = progressHeadline(input.kind, input.cancelling);
  const estimate = formatEstimateLabel(input.kind, input.estimateMs);
  const elapsed = formatElapsed(input.elapsedSeconds);
  return `${headline} ${estimate} · 已用 ${elapsed}`;
}

export function batchReviseLabel(openCount: number): string {
  return `AI 统一修改 (${openCount})`;
}

export function acceptSelectedLabel(selectedCount: number): string {
  return selectedCount > 0 ? `通过所选 (${selectedCount})` : "通过所选";
}

export function quotePreview(exact: string, max = 80): string {
  const trimmed = exact.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}
