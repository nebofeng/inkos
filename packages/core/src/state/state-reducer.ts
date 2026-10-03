import {
  ChapterSummariesStateSchema,
  CurrentStateStateSchema,
  HooksStateSchema,
  RuntimeStateDeltaSchema,
  StateManifestSchema,
  type HookRecord,
  type ChapterSummariesState,
  type CurrentStateState,
  type HooksState,
  type RuntimeStateDelta,
  type StateManifest,
} from "../models/runtime-state.js";
import { evaluateHookAdmission } from "../utils/hook-governance.js";
import { resolveHookPayoffTiming } from "../utils/hook-lifecycle.js";
import { validateRuntimeState } from "./state-validator.js";

export interface RuntimeStateSnapshot {
  readonly manifest: StateManifest;
  readonly currentState: CurrentStateState;
  readonly hooks: HooksState;
  readonly chapterSummaries: ChapterSummariesState;
}

export function applyRuntimeStateDelta(params: {
  readonly snapshot: RuntimeStateSnapshot;
  readonly delta: RuntimeStateDelta;
  readonly allowReapply?: boolean;
}): RuntimeStateSnapshot {
  const snapshot = {
    manifest: StateManifestSchema.parse(params.snapshot.manifest),
    currentState: CurrentStateStateSchema.parse(params.snapshot.currentState),
    hooks: HooksStateSchema.parse(params.snapshot.hooks),
    chapterSummaries: ChapterSummariesStateSchema.parse(params.snapshot.chapterSummaries),
  };
  const delta = RuntimeStateDeltaSchema.parse(params.delta);
  const allowReapply = params.allowReapply ?? false;

  if (allowReapply ? delta.chapter < snapshot.manifest.lastAppliedChapter : delta.chapter <= snapshot.manifest.lastAppliedChapter) {
    throw new Error(`delta chapter ${delta.chapter} goes backwards`);
  }

  if (delta.chapterSummary && delta.chapterSummary.chapter !== delta.chapter) {
    throw new Error(`chapter summary ${delta.chapterSummary.chapter} does not match delta chapter ${delta.chapter}`);
  }

  if (
    delta.chapterSummary
    && snapshot.chapterSummaries.rows.some((row) => row.chapter === delta.chapterSummary?.chapter)
    && !allowReapply
  ) {
    throw new Error(`duplicate summary row for chapter ${delta.chapterSummary.chapter}`);
  }

  const hooks = applyHookOps(snapshot.hooks, delta);
  const currentState = applyCurrentStatePatch(
    snapshot.currentState,
    snapshot.manifest.language,
    delta,
  );
  const chapterSummaries = applySummaryDelta(snapshot.chapterSummaries, delta, allowReapply);

  const next: RuntimeStateSnapshot = {
    manifest: {
      ...snapshot.manifest,
      lastAppliedChapter: delta.chapter,
    },
    currentState,
    hooks,
    chapterSummaries,
  };

  const issues = validateRuntimeState(next);
  if (issues.length > 0) {
    throw new Error(issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "));
  }

  return next;
}

function applyHookOps(hooksState: HooksState, delta: RuntimeStateDelta): HooksState {
  const hooksById = new Map(hooksState.hooks.map((hook) => [hook.hookId, { ...hook }]));

  for (const hook of delta.hookOps.upsert) {
    const sameHook = hooksById.get(hook.hookId);
    if (sameHook) {
      hooksById.set(sameHook.hookId, mergeHookRecord(sameHook, hook));
      continue;
    }

    const admission = evaluateHookAdmission({
      candidate: {
        type: hook.type,
        expectedPayoff: hook.expectedPayoff,
        notes: hook.notes,
      },
    });

    if (!admission.admit) {
      throw new Error(`invalid hook ${hook.hookId}: ${admission.reason}`);
    }

    hooksById.set(hook.hookId, { ...hook });
  }

  for (const hookId of delta.hookOps.resolve) {
    const existing = hooksById.get(hookId);
    if (!existing) {
      // Hook may have been cleared by a previous settlement or not yet created — skip gracefully
      continue;
    }
    hooksById.set(hookId, {
      ...existing,
      status: "resolved",
      lastAdvancedChapter: Math.max(existing.lastAdvancedChapter, delta.chapter),
    });
  }

  for (const hookId of delta.hookOps.defer) {
    const existing = hooksById.get(hookId);
    if (!existing) {
      continue;
    }
    hooksById.set(hookId, {
      ...existing,
      status: "deferred",
      lastAdvancedChapter: Math.max(existing.lastAdvancedChapter, delta.chapter),
    });
  }

  return {
    hooks: [...hooksById.values()].sort((left, right) => (
      left.startChapter - right.startChapter
      || left.lastAdvancedChapter - right.lastAdvancedChapter
      || left.hookId.localeCompare(right.hookId)
    )),
  };
}

function mergeHookRecord(existing: HookRecord, incoming: HookRecord): HookRecord {
  const expectedPayoff = preferRicherText(existing.expectedPayoff, incoming.expectedPayoff);
  const advanced = Math.max(existing.lastAdvancedChapter, incoming.lastAdvancedChapter);
  const progressed = advanced > existing.lastAdvancedChapter;
  // When the hook really advanced, the new note is the news; keeping whichever
  // note was longer froze many hooks on their chapter-1 description.
  const notes = progressed
    ? appendChapterNote(existing.notes, incoming.notes, advanced)
    : preferRicherText(existing.notes, incoming.notes);

  return {
    ...existing,
    startChapter: Math.min(existing.startChapter, incoming.startChapter),
    type: preferRicherText(existing.type, incoming.type),
    status: mergeHookStatus(existing.status, incoming.status, progressed),
    lastAdvancedChapter: advanced,
    expectedPayoff,
    payoffTiming: resolveHookPayoffTiming({
      payoffTiming: incoming.payoffTiming ?? existing.payoffTiming,
      expectedPayoff,
      notes,
    }),
    notes,
  };
}

function mergeHookStatus(
  existing: HookRecord["status"],
  incoming: HookRecord["status"],
  progressed: boolean,
): HookRecord["status"] {
  if (existing === "resolved" || incoming === "resolved") return "resolved";
  if (progressed || existing === "progressing" || incoming === "progressing") return "progressing";
  return existing;
}

/** Upper bound for a hook's accumulated notes (one markdown table cell). */
export const HOOK_NOTES_MAX_CHARS = 360;
const CHAPTER_NOTE_PREFIX = /^第\s*\d+\s*章\s*[：:]/;
const CHAPTER_NOTE_SPLIT = /[；;]\s*(?=第\s*\d+\s*章\s*[：:])/;

/**
 * Append the incoming note as "第N章：…" to the existing notes, dropping the
 * oldest chapter entries (never the original seed description first) once the
 * cell grows beyond HOOK_NOTES_MAX_CHARS.
 */
export function appendChapterNote(
  existingNotes: string,
  incomingNotes: string,
  chapter: number,
  maxChars: number = HOOK_NOTES_MAX_CHARS,
): string {
  const previous = existingNotes.trim();
  const raw = incomingNotes.trim();
  if (!raw) return capChapterNotes(previous, maxChars);
  if (!previous || raw === previous) return capChapterNotes(stampChapterNote(raw, chapter), maxChars);
  // The model sometimes rewrites the full cumulative note itself.
  if (raw.includes(previous)) return capChapterNotes(raw, maxChars);

  const fresh = stampChapterNote(raw, chapter);
  if (previous.includes(fresh) || previous.includes(raw)) return capChapterNotes(previous, maxChars);
  return capChapterNotes(`${previous}；${fresh}`, maxChars);
}

function stampChapterNote(note: string, chapter: number): string {
  const trimmed = note.trim();
  // Already chapter-stamped ("第13章：…" or "第13章马跃离场").
  if (/^第\s*\d+\s*章/.test(trimmed)) return trimmed;
  const body = trimmed
    .replace(/^(?:本章|这一章|此章|当前章节?)\s*[：:，,]?\s*/, "")
    .replace(/本章/g, `第${chapter}章`);
  return `第${chapter}章：${body}`;
}

function capChapterNotes(notes: string, maxChars: number): string {
  if (notes.length <= maxChars) return notes;
  const parts = notes.split(CHAPTER_NOTE_SPLIT).map((part) => part.trim()).filter(Boolean);
  const head = parts[0] && !CHAPTER_NOTE_PREFIX.test(parts[0]) ? parts.shift()! : undefined;
  const entries = [...parts];
  const join = (items: ReadonlyArray<string>): string => items.join("；");
  // Drop the oldest chapter entries first, keeping the newest one.
  while (entries.length > 1 && join(head ? [head, ...entries] : entries).length > maxChars) {
    entries.shift();
  }
  let result = join(head ? [head, ...entries] : entries);
  if (result.length > maxChars && head) {
    const latest = join(entries);
    const room = maxChars - latest.length - 2;
    result = room > 8 ? `${head.slice(0, room)}…；${latest}` : latest;
  }
  return result.length > maxChars ? `${result.slice(0, maxChars - 1)}…` : result;
}

function preferRicherText(primary: string, fallback: string): string {
  const left = primary.trim();
  const right = fallback.trim();

  if (!left) return right;
  if (!right) return left;
  if (left === right) return left;
  return right.length > left.length ? right : left;
}

function applyCurrentStatePatch(
  currentState: CurrentStateState,
  language: "zh" | "en",
  delta: RuntimeStateDelta,
): CurrentStateState {
  if (!delta.currentStatePatch) {
    return {
      chapter: delta.chapter,
      facts: [...currentState.facts],
    };
  }

  const nextFacts = [...currentState.facts];
  const labels = language === "en"
    ? {
      currentLocation: ["Current Location", "当前位置"],
      protagonistState: ["Protagonist State", "主角状态"],
      currentGoal: ["Current Goal", "当前目标"],
      currentConstraint: ["Current Constraint", "当前限制"],
      currentAlliances: ["Current Alliances", "Current Relationships", "当前敌我"],
      currentConflict: ["Current Conflict", "当前冲突"],
    }
    : {
      currentLocation: ["当前位置", "Current Location"],
      protagonistState: ["主角状态", "Protagonist State"],
      currentGoal: ["当前目标", "Current Goal"],
      currentConstraint: ["当前限制", "Current Constraint"],
      currentAlliances: ["当前敌我", "Current Alliances", "Current Relationships"],
      currentConflict: ["当前冲突", "Current Conflict"],
    };

  for (const [patchKey, aliases] of Object.entries(labels) as Array<[
    keyof typeof labels,
    string[],
  ]>) {
    const value = delta.currentStatePatch[patchKey];
    if (value === undefined) continue;

    for (let index = nextFacts.length - 1; index >= 0; index -= 1) {
      const predicate = nextFacts[index]?.predicate ?? "";
      if (aliases.some((alias) => alias.toLowerCase() === predicate.toLowerCase())) {
        nextFacts.splice(index, 1);
      }
    }

    nextFacts.push({
      subject: "protagonist",
      predicate: aliases[0]!,
      object: value,
      validFromChapter: delta.chapter,
      validUntilChapter: null,
      sourceChapter: delta.chapter,
    });
  }

  return {
    chapter: delta.chapter,
    facts: nextFacts.sort((left, right) => (
      left.predicate.localeCompare(right.predicate)
      || left.object.localeCompare(right.object)
    )),
  };
}

function applySummaryDelta(
  state: ChapterSummariesState,
  delta: RuntimeStateDelta,
  allowReapply = false,
): ChapterSummariesState {
  if (!delta.chapterSummary) {
    return {
      rows: [...state.rows].sort((left, right) => left.chapter - right.chapter),
    };
  }

  return {
    rows: [
      ...(allowReapply ? state.rows.filter((row) => row.chapter !== delta.chapterSummary!.chapter) : state.rows),
      delta.chapterSummary,
    ].sort((left, right) => left.chapter - right.chapter),
  };
}
