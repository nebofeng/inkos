/**
 * Pure helpers for wiring notes onto ChapterReader body text.
 * Visible offsets match simulateChapterReaderVisible (paragraphs joined by \n).
 */

import type { AnnotationStatus, ChapterNote } from "../lib/annotation-client";
import { simulateChapterReaderVisible, type VisibleIndex } from "../api/lib/annotation-selection";

export type RailTab = "chat" | "notes";
export type HighlightStatus = "open" | "suggested" | "orphaned";

export interface NoteHighlight {
  readonly noteId: string;
  readonly status: HighlightStatus;
  readonly start: number;
  readonly end: number;
}

export interface HighlightSegment {
  readonly text: string;
  readonly noteId?: string;
  readonly status?: HighlightStatus;
  readonly anchor?: boolean;
}

export const HIGHLIGHT_CLASS: Record<HighlightStatus, string> = {
  open: "border-b-2 border-dashed border-amber-400/80 hover:bg-amber-50/50 cursor-pointer transition-colors",
  suggested: "border-b-2 border-indigo-500 bg-indigo-50/30 cursor-pointer transition-colors",
  orphaned: "border-b-2 border-dotted border-zinc-300 text-zinc-400 cursor-not-allowed",
};

export const PARAGRAPH_FALLBACK_TOAST = "已按段落添加备注";
export const NOTE_ANCHOR_SCROLL_MARGIN_CLASS = "scroll-mt-24";
export const RIGHT_RAIL_WIDTH_CLASS = "w-[340px]";

const HIGHLIGHT_STATUSES = new Set<HighlightStatus>(["open", "suggested", "orphaned"]);

export function isHighlightStatus(status: AnnotationStatus): status is HighlightStatus {
  return HIGHLIGHT_STATUSES.has(status as HighlightStatus);
}

export function railNotesLabel(count: number): string {
  return `备注 (${count})`;
}

export function noteAnchorId(noteId: string): string {
  return `note-anchor-${noteId}`;
}

export function paragraphVisibleRanges(paragraphs: ReadonlyArray<string>): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let offset = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    if (i > 0) offset += 1;
    const start = offset;
    offset += paragraphs[i]!.length;
    ranges.push({ start, end: offset });
  }
  return ranges;
}

/** Map a Markdown source range onto ChapterReader visible offsets. */
export function sourceRangeToVisible(
  index: VisibleIndex,
  sourceStart: number,
  sourceEnd: number,
): { start: number; end: number } | null {
  if (sourceEnd <= sourceStart || index.map.length === 0) return null;
  let start: number | undefined;
  let end: number | undefined;
  for (let i = 0; i < index.map.length; i++) {
    const src = index.map[i]!;
    if (src >= sourceStart && src < sourceEnd) {
      // Paragraph join newlines reuse the next char source index; skip them.
      if (
        index.visible[i] === "\n" &&
        i + 1 < index.map.length &&
        index.map[i + 1] === src
      ) {
        continue;
      }
      if (start === undefined) start = i;
      end = i + 1;
    }
  }
  if (start === undefined || end === undefined || end <= start) return null;
  return { start, end };
}

export function highlightsFromNotes(
  notes: ReadonlyArray<ChapterNote>,
  index: VisibleIndex,
): NoteHighlight[] {
  const out: NoteHighlight[] = [];
  for (const note of notes) {
    if (!isHighlightStatus(note.status)) continue;
    const range = sourceRangeToVisible(index, note.selector.start, note.selector.end);
    if (!range) continue;
    out.push({
      noteId: note.id,
      status: note.status,
      start: range.start,
      end: range.end,
    });
  }
  return out;
}

export function safeChapterReaderVisible(source: string): VisibleIndex {
  try {
    return simulateChapterReaderVisible(source);
  } catch {
    return { visible: "", map: [] };
  }
}

export function splitHighlightedText(
  text: string,
  origin: number,
  highlights: ReadonlyArray<NoteHighlight>,
): HighlightSegment[] {
  const lo = origin;
  const hi = origin + text.length;
  const cuts = new Set<number>([0, text.length]);
  const active: Array<{ relStart: number; relEnd: number; noteId: string; status: HighlightStatus }> = [];
  for (const highlight of highlights) {
    const relStart = Math.max(highlight.start, lo) - lo;
    const relEnd = Math.min(highlight.end, hi) - lo;
    if (relEnd <= relStart) continue;
    active.push({ relStart, relEnd, noteId: highlight.noteId, status: highlight.status });
    cuts.add(relStart);
    cuts.add(relEnd);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const segments: HighlightSegment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (b <= a) continue;
    const hit = active.find((item) => item.relStart <= a && item.relEnd >= b);
    segments.push({
      text: text.slice(a, b),
      noteId: hit?.noteId,
      status: hit?.status,
      anchor: hit ? a === hit.relStart : false,
    });
  }
  return segments.length > 0 ? segments : [{ text }];
}
