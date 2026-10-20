/**
 * Pure helpers for the notes rail: filters, badges, word-level diff,
 * overlapping patches, elapsed time, and selection→selector fallback.
 */

import {
  type AnnotationOrigin,
  type AnnotationStatus,
  type TextQuotePositionSelector,
  buildSelector,
  paragraphAnchorAt,
  prepareSourceSelection,
} from "../api/lib/annotation-anchors";
import {
  mapVisibleRangeToSource,
  simulateChapterReaderVisible,
  simulateStreamdownVisible,
  type VisibleIndex,
} from "../api/lib/annotation-selection";

export type { AnnotationOrigin, AnnotationStatus, TextQuotePositionSelector };

export type NoteFilterKey = "all" | "mine" | "open" | "suggested" | "orphaned";

export const NOTE_FILTER_KEYS: readonly NoteFilterKey[] = ["all", "mine", "open", "suggested", "orphaned"];

export const NOTE_FILTER_LABELS: Record<NoteFilterKey, string> = {
  all: "全部",
  mine: "我的建议",
  open: "待处理",
  suggested: "已改",
  orphaned: "失效",
};

export const NOTE_STATUS_BADGE: Record<AnnotationStatus, string> = {
  open: "待处理",
  suggested: "已出建议",
  accepted: "已通过",
  rejected: "已忽略",
  orphaned: "原句已改动",
};

export interface NoteFilterItem {
  readonly origin: AnnotationOrigin;
  readonly status: AnnotationStatus;
}

export type DiffTokenType = "same" | "del" | "add";

export interface DiffToken {
  readonly type: DiffTokenType;
  readonly text: string;
}

export interface PatchSpan {
  readonly noteId: string;
  readonly start: number;
  readonly end: number;
}

export type VisibleRenderer = "chapter-reader" | "streamdown";

export interface ResolveSelectorInput {
  readonly source: string;
  readonly sourceStart?: number;
  readonly sourceEnd?: number;
  readonly visibleStart?: number;
  readonly visibleEnd?: number;
  readonly renderer?: VisibleRenderer;
}

export interface ResolvedNoteSelector {
  readonly selector: TextQuotePositionSelector;
  readonly usedParagraphFallback: boolean;
}

export function noteStatusBadge(status: AnnotationStatus): string {
  return NOTE_STATUS_BADGE[status];
}

export function matchesNoteFilter(note: NoteFilterItem, filter: NoteFilterKey): boolean {
  switch (filter) {
    case "all":
      return true;
    case "mine":
      return note.origin === "user";
    case "open":
      return note.status === "open";
    case "suggested":
      return note.status === "suggested";
    case "orphaned":
      return note.status === "orphaned";
  }
}

export function filterNotes<T extends NoteFilterItem>(
  notes: ReadonlyArray<T>,
  filter: NoteFilterKey,
): T[] {
  return notes.filter((note) => matchesNoteFilter(note, filter));
}

export function countNotesByFilter(notes: ReadonlyArray<NoteFilterItem>): Record<NoteFilterKey, number> {
  const counts: Record<NoteFilterKey, number> = {
    all: notes.length,
    mine: 0,
    open: 0,
    suggested: 0,
    orphaned: 0,
  };
  for (const note of notes) {
    if (note.origin === "user") counts.mine += 1;
    if (note.status === "open") counts.open += 1;
    else if (note.status === "suggested") counts.suggested += 1;
    else if (note.status === "orphaned") counts.orphaned += 1;
  }
  return counts;
}

/** Word-level diff; CJK is split per character, Latin stays as words. */
export function wordDiff(original: string, suggested: string): DiffToken[] {
  if (original === suggested) {
    return original ? [{ type: "same", text: original }] : [];
  }
  return mergeDiffTokens(diffTokens(tokenize(original), tokenize(suggested)));
}

export function overlappingPatchIds(patches: ReadonlyArray<PatchSpan>): string[] {
  const ids: string[] = [];
  for (let i = 0; i < patches.length; i++) {
    for (let j = i + 1; j < patches.length; j++) {
      const a = patches[i]!;
      const b = patches[j]!;
      if (a.start < b.end && b.start < a.end) {
        if (!ids.includes(a.noteId)) ids.push(a.noteId);
        if (!ids.includes(b.noteId)) ids.push(b.noteId);
      }
    }
  }
  return ids;
}

/** Overlapping patches disable「全部通过」; caller still decides empty-list UX. */
export function canAcceptAllPatches(patches: ReadonlyArray<PatchSpan>): boolean {
  return overlappingPatchIds(patches).length === 0;
}

export function formatElapsed(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/**
 * Build a quote selector from source offsets, or fall back to the enclosing
 * paragraph when the selection cannot be mapped (short/failed DOM→Markdown).
 */
export function resolveAnnotationSelector(input: ResolveSelectorInput): ResolvedNoteSelector | null {
  const source = input.source;
  if (!source) return null;

  const sourceRange = validSourceRange(source, input.sourceStart, input.sourceEnd);
  if (sourceRange) {
    try {
      return {
        selector: prepareSourceSelection(source, sourceRange.start, sourceRange.end),
        usedParagraphFallback: false,
      };
    } catch {
      // fall through to paragraph
    }
  }

  const mapped = mapVisibleSelection(source, input.visibleStart, input.visibleEnd, input.renderer ?? "chapter-reader");
  if (mapped) {
    try {
      return {
        selector: prepareSourceSelection(source, mapped.start, mapped.end),
        usedParagraphFallback: false,
      };
    } catch {
      // fall through to paragraph
    }
  }

  const hint =
    finiteOffset(input.sourceStart)
    ?? visiblePointToSource(source, input.visibleStart, input.renderer ?? "chapter-reader")
    ?? 0;
  return paragraphSelectorAt(source, hint);
}

export function paragraphSelectorAt(source: string, offset: number): ResolvedNoteSelector | null {
  const anchor = paragraphAnchorAt(source, clampOffset(offset, source.length));
  if (!anchor || anchor.end <= anchor.start) return null;
  try {
    return {
      selector: buildSelector(source, anchor.start, anchor.end),
      usedParagraphFallback: true,
    };
  } catch {
    return null;
  }
}

function validSourceRange(
  source: string,
  start: number | undefined,
  end: number | undefined,
): { start: number; end: number } | null {
  if (
    typeof start !== "number"
    || typeof end !== "number"
    || !Number.isInteger(start)
    || !Number.isInteger(end)
    || start < 0
    || end > source.length
    || end <= start
  ) {
    return null;
  }
  return { start, end };
}

function finiteOffset(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampOffset(value: number, length: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(length, Math.trunc(value)));
}

function visibleIndex(source: string, renderer: VisibleRenderer): VisibleIndex {
  return renderer === "streamdown" ? simulateStreamdownVisible(source) : simulateChapterReaderVisible(source);
}

function mapVisibleSelection(
  source: string,
  visibleStart: number | undefined,
  visibleEnd: number | undefined,
  renderer: VisibleRenderer,
): { start: number; end: number } | null {
  if (
    visibleStart === undefined
    || visibleEnd === undefined
    || !Number.isFinite(visibleStart)
    || !Number.isFinite(visibleEnd)
    || visibleEnd <= visibleStart
  ) {
    return null;
  }
  try {
    return mapVisibleRangeToSource(visibleIndex(source, renderer), visibleStart, visibleEnd);
  } catch {
    return null;
  }
}

function visiblePointToSource(
  source: string,
  visibleStart: number | undefined,
  renderer: VisibleRenderer,
): number | undefined {
  if (visibleStart === undefined || !Number.isFinite(visibleStart) || visibleStart < 0) return undefined;
  try {
    const index = visibleIndex(source, renderer);
    if (index.visible.length === 0) return undefined;
    const lo = Math.min(Math.floor(visibleStart), index.visible.length - 1);
    return mapVisibleRangeToSource(index, lo, lo + 1)?.start;
  } catch {
    return undefined;
  }
}

function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x3400 && code <= 0x9fff)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0x3040 && code <= 0x30ff)
    || (code >= 0xac00 && code <= 0xd7af)
  );
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (isCjk(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (/[A-Za-z0-9]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9]/.test(text[j]!)) j += 1;
      tokens.push(text.slice(i, j));
      i = j;
      continue;
    }
    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j += 1;
      tokens.push(text.slice(i, j));
      i = j;
      continue;
    }
    tokens.push(ch);
    i += 1;
  }
  return tokens;
}

function diffTokens(a: ReadonlyArray<string>, b: ReadonlyArray<string>): DiffToken[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  const raw: DiffToken[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      raw.push({ type: "same", text: a[i - 1]! });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      raw.push({ type: "add", text: b[j - 1]! });
      j -= 1;
    } else {
      raw.push({ type: "del", text: a[i - 1]! });
      i -= 1;
    }
  }
  raw.reverse();
  return raw;
}

function mergeDiffTokens(tokens: ReadonlyArray<DiffToken>): DiffToken[] {
  const merged: DiffToken[] = [];
  for (const token of tokens) {
    const last = merged[merged.length - 1];
    if (last && last.type === token.type) {
      merged[merged.length - 1] = { type: last.type, text: last.text + token.text };
    } else {
      merged.push(token);
    }
  }
  return merged;
}
