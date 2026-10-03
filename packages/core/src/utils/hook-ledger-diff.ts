import type { StoredHook } from "../state/memory-db.js";
import { normalizeStoredHookStatus, resolveHookPayoffTiming } from "./hook-lifecycle.js";
import { parsePendingHooksMarkdown } from "./story-markdown.js";

const FIELDS = [
  ["status", (hook: StoredHook) => normalizeStoredHookStatus(hook.status)],
  ["type", (hook: StoredHook) => hook.type.trim()],
  ["startChapter", (hook: StoredHook) => String(hook.startChapter)],
  ["lastAdvancedChapter", (hook: StoredHook) => String(hook.lastAdvancedChapter)],
  ["expectedPayoff", (hook: StoredHook) => hook.expectedPayoff.trim()],
  ["payoffTiming", (hook: StoredHook) => resolveHookPayoffTiming(hook)],
  ["dependsOn", (hook: StoredHook) => (hook.dependsOn ?? []).join(", ")],
  ["paysOffInArc", (hook: StoredHook) => (hook.paysOffInArc ?? "").trim()],
  ["coreHook", (hook: StoredHook) => (hook.coreHook ? "yes" : "")],
  ["promoted", (hook: StoredHook) => (hook.promoted === undefined ? "" : String(hook.promoted))],
  ["notes", (hook: StoredHook) => hook.notes.trim()],
] as const;

const MAX_VALUE_CHARS = 200;

function clip(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > MAX_VALUE_CHARS ? `${compact.slice(0, MAX_VALUE_CHARS)}…` : compact;
}

function describeHook(hook: StoredHook): string {
  return FIELDS
    .map(([field, read]) => [field, read(hook)] as const)
    .filter(([, value]) => value !== "")
    .map(([field, value]) => `${field}=${JSON.stringify(clip(value))}`)
    .join("; ");
}

export interface HookLedgerDiff {
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
  readonly changed: ReadonlyArray<{ readonly hookId: string; readonly fields: ReadonlyArray<string> }>;
  readonly unchanged: ReadonlyArray<string>;
}

/**
 * Compare two pending_hooks ledgers per hookId and per field. Status cells are
 * normalized first, so diagnostic markers ("deferred (受阻于 H001 (已阻 8 章))")
 * or a changed blocked-distance do not register as hook changes.
 * Returns null when either side has no parseable hook rows.
 */
export function diffHookLedgers(oldMarkdown: string, newMarkdown: string): HookLedgerDiff | null {
  const oldHooks = parsePendingHooksMarkdown(oldMarkdown);
  const newHooks = parsePendingHooksMarkdown(newMarkdown);
  if (oldHooks.length === 0 || newHooks.length === 0) return null;

  const oldById = new Map(oldHooks.map((hook) => [hook.hookId, hook]));
  const newById = new Map(newHooks.map((hook) => [hook.hookId, hook]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: Array<{ hookId: string; fields: string[] }> = [];
  const unchanged: string[] = [];

  for (const hook of newHooks) {
    const before = oldById.get(hook.hookId);
    if (!before) {
      added.push(`${hook.hookId}: ${describeHook(hook)}`);
      continue;
    }
    const fields: string[] = [];
    for (const [field, read] of FIELDS) {
      const left = read(before);
      const right = read(hook);
      if (left !== right) fields.push(`${field}: ${JSON.stringify(clip(left))} -> ${JSON.stringify(clip(right))}`);
    }
    if (fields.length > 0) changed.push({ hookId: hook.hookId, fields });
    else unchanged.push(hook.hookId);
  }
  for (const hook of oldHooks) {
    if (!newById.has(hook.hookId)) removed.push(`${hook.hookId}: ${describeHook(hook)}`);
  }
  return { added, removed, changed, unchanged };
}

export function renderHookLedgerDiff(diff: HookLedgerDiff, label = "Hooks Pool"): string | null {
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) return null;
  const parts = [`### ${label} (per hookId, per field)`];
  if (diff.changed.length > 0) {
    parts.push("Changed:\n" + diff.changed
      .map((entry) => `~ ${entry.hookId}\n${entry.fields.map((field) => `    ${field}`).join("\n")}`)
      .join("\n"));
  }
  if (diff.added.length > 0) parts.push("Added:\n" + diff.added.map((line) => `+ ${line}`).join("\n"));
  if (diff.removed.length > 0) {
    parts.push("Removed (no longer in the pool):\n" + diff.removed.map((line) => `- ${line}`).join("\n"));
  }
  if (diff.unchanged.length > 0) {
    parts.push(`Unchanged (kept as before, not dropped): ${diff.unchanged.join(", ")}`);
  }
  return parts.join("\n");
}
