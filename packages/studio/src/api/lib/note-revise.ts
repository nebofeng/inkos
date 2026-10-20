/**
 * Map annotation notes ↔ spot-fix patches and apply accepted ones from the back.
 */

import type { AuditIssue } from "@actalk/inkos-core";
import type { ChapterNote } from "./annotation-store.js";

export const NOTE_REVISE_MAX = 20;

export const NOTE_REVISE_CONSTRAINT =
  "每条备注至少一个 PATCH；TARGET_TEXT 必须等于该备注原文或包含它的整句，且全文唯一。禁止输出 REVISED_CONTENT。";

export interface SpotPatch {
  readonly targetText: string;
  readonly replacementText: string;
}

export interface NoteRevisePatch {
  readonly noteId: string;
  readonly targetText: string;
  readonly replacementText: string;
  readonly start: number;
  readonly end: number;
}

export interface UnmatchedPatch {
  readonly noteId?: string;
  readonly targetText?: string;
  readonly reason: string;
}

export function notesToAuditIssues(notes: ReadonlyArray<ChapterNote>): AuditIssue[] {
  const issues: AuditIssue[] = [
    {
      severity: "critical",
      category: "annotation-batch",
      description: NOTE_REVISE_CONSTRAINT,
      suggestion: "为每条备注输出一个 PATCH，TARGET_TEXT 从原文精确复制。",
      repairScope: "local",
    },
  ];
  for (const note of notes) {
    issues.push({
      severity: "warning",
      category: "annotation",
      description: `【annotationId=${note.id}】原文：「${note.selector.exact}」。用户要求：${note.comment}`,
      suggestion: "TARGET_TEXT 必须等于该备注原文或包含它的整句，且在全文中唯一。",
      repairScope: "local",
    });
  }
  return issues;
}

export function matchPatchesToNotes(
  source: string,
  notes: ReadonlyArray<ChapterNote>,
  patches: ReadonlyArray<SpotPatch>,
): { patches: NoteRevisePatch[]; unmatched: UnmatchedPatch[] } {
  const remaining = notes.slice();
  const matched: NoteRevisePatch[] = [];
  const unmatched: UnmatchedPatch[] = [];

  for (const patch of patches) {
    const targetText = patch.targetText.trim();
    const replacementText = patch.replacementText;
    if (!targetText) {
      unmatched.push({ reason: "empty-target" });
      continue;
    }
    const located = locateUnique(source, targetText);
    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < remaining.length; i++) {
      const note = remaining[i]!;
      const score = scoreNote(note, targetText, located);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      } else if (score === bestScore && score > 0 && bestIndex >= 0) {
        const current = remaining[bestIndex]!;
        const noteDist = rangeDistance(note.selector.start, note.selector.end, located?.start ?? note.selector.start);
        const curDist = rangeDistance(current.selector.start, current.selector.end, located?.start ?? current.selector.start);
        if (noteDist < curDist) bestIndex = i;
      }
    }
    if (bestIndex < 0 || bestScore <= 0) {
      unmatched.push({ targetText, reason: "no-note" });
      continue;
    }
    const note = remaining.splice(bestIndex, 1)[0]!;
    const range = resolvePatchRange(source, note, targetText, located);
    if (!range) {
      unmatched.push({ noteId: note.id, targetText, reason: "not-unique" });
      remaining.push(note);
      continue;
    }
    matched.push({
      noteId: note.id,
      targetText,
      replacementText,
      start: range.start,
      end: range.end,
    });
  }

  for (const note of remaining) {
    unmatched.push({ noteId: note.id, targetText: note.selector.exact, reason: "no-patch" });
  }

  return { patches: matched, unmatched };
}

export function overlappingPatchIds(patches: ReadonlyArray<NoteRevisePatch>): string[] {
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

export function applyAcceptedPatches(
  source: string,
  patches: ReadonlyArray<NoteRevisePatch>,
): { next: string; applied: NoteRevisePatch[] } {
  const ordered = [...patches].sort((a, b) => b.start - a.start || b.end - a.end);
  let next = source;
  const applied: NoteRevisePatch[] = [];
  for (const patch of ordered) {
    const located = locateForApply(next, patch);
    if (!located) continue;
    next = next.slice(0, located.start) + patch.replacementText + next.slice(located.end);
    applied.push(patch);
  }
  return { next, applied };
}

function scoreNote(
  note: ChapterNote,
  targetText: string,
  located: { start: number; end: number } | null,
): number {
  const exact = note.selector.exact;
  if (targetText === exact) return 3;
  if (targetText.includes(exact) || exact.includes(targetText)) return 2;
  if (
    located
    && rangesOverlap(located.start, located.end, note.selector.start, note.selector.end)
  ) {
    return 1;
  }
  return 0;
}

function resolvePatchRange(
  source: string,
  note: ChapterNote,
  targetText: string,
  located: { start: number; end: number } | null,
): { start: number; end: number } | null {
  const selectorSlice = source.slice(note.selector.start, note.selector.end);
  if (selectorSlice === targetText) {
    return { start: note.selector.start, end: note.selector.end };
  }
  if (selectorSlice.includes(targetText)) {
    const inner = selectorSlice.indexOf(targetText);
    return { start: note.selector.start + inner, end: note.selector.start + inner + targetText.length };
  }
  if (targetText.includes(selectorSlice) && located) return located;
  if (located) return located;
  return null;
}

function locateUnique(source: string, target: string): { start: number; end: number } | null {
  const start = source.indexOf(target);
  if (start === -1) return null;
  const another = source.indexOf(target, start + target.length);
  if (another !== -1) return null;
  return { start, end: start + target.length };
}

function locateForApply(
  source: string,
  patch: NoteRevisePatch,
): { start: number; end: number } | null {
  if (
    patch.start >= 0
    && patch.end <= source.length
    && source.slice(patch.start, patch.end) === patch.targetText
  ) {
    return { start: patch.start, end: patch.end };
  }
  return locateUnique(source, patch.targetText);
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function rangeDistance(start: number, end: number, point: number): number {
  if (point >= start && point <= end) return 0;
  return Math.min(Math.abs(point - start), Math.abs(point - end));
}
