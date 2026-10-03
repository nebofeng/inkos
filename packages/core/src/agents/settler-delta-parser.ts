import {
  HookStatusSchema,
  HookPayoffTimingSchema,
  RuntimeStateDeltaSchema,
  type RuntimeStateDelta,
} from "../models/runtime-state.js";
import { normalizeHookPayoffTiming, resolveHookStatusAlias } from "../utils/hook-lifecycle.js";

export interface SettlerDeltaOutput {
  readonly postSettlement: string;
  readonly runtimeStateDelta: RuntimeStateDelta;
  /** Alias / annotation fixes applied before schema validation (for logs). */
  readonly normalizations?: ReadonlyArray<string>;
}

function sanitizeJSON(str: string): string {
  return str
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/,\s*([}\]])/g, "$1");
}

export function parseSettlerDeltaOutput(content: string): SettlerDeltaOutput {
  const extract = (tag: string): string => {
    const regex = new RegExp(
      `=== ${tag} ===\\s*([\\s\\S]*?)(?==== [A-Z_]+ ===|$)`,
    );
    const match = content.match(regex);
    return match?.[1]?.trim() ?? "";
  };

  const rawDelta = extract("RUNTIME_STATE_DELTA");
  if (!rawDelta) {
    throw new Error("runtime state delta block is missing");
  }

  const jsonPayload = stripCodeFence(rawDelta);
  let parsed: unknown;
  try {
    parsed = JSON.parse(sanitizeJSON(jsonPayload));
  } catch (error) {
    throw new Error(`runtime state delta is not valid JSON: ${String(error)}`);
  }

  const normalizations = normalizeRuntimeStateDeltaPayload(parsed);

  try {
    return {
      postSettlement: extract("POST_SETTLEMENT"),
      runtimeStateDelta: RuntimeStateDeltaSchema.parse(parsed),
      ...(normalizations.length > 0 ? { normalizations } : {}),
    };
  } catch (error) {
    throw new Error(`runtime state delta failed schema validation: ${String(error)}`);
  }
}

/**
 * Models regularly write hook statuses the way the prompt / ledger shows them
 * ("已回收", "延后", "pressured", "deferred (受阻于 H001 (已阻 8 章))") and
 * payoff timings in Chinese ("慢烧"). InkOS already knows these aliases; map
 * them in place before zod validation instead of rejecting the whole
 * settlement. Unknown statuses are left untouched so validation still fails.
 * Unrecognised payoffTiming values are dropped (the field is optional and the
 * reducer re-derives it).
 */
export function normalizeRuntimeStateDeltaPayload(payload: unknown): string[] {
  const changes: string[] = [];
  if (!payload || typeof payload !== "object") return changes;
  const root = payload as Record<string, unknown>;

  const fix = (value: unknown, where: string): void => {
    if (!value || typeof value !== "object") return;
    const hook = value as Record<string, unknown>;
    const label = `${where}:${String(hook.hookId ?? hook.type ?? "?")}`;
    if (typeof hook.status === "string" && !HookStatusSchema.safeParse(hook.status).success) {
      const resolved = resolveHookStatusAlias(hook.status);
      if (resolved) {
        changes.push(`${label} status "${hook.status}" -> ${resolved}`);
        hook.status = resolved;
      }
    }
    if (hook.payoffTiming !== undefined && !HookPayoffTimingSchema.safeParse(hook.payoffTiming).success) {
      const resolved = typeof hook.payoffTiming === "string"
        ? normalizeHookPayoffTiming(hook.payoffTiming)
        : undefined;
      if (resolved) {
        changes.push(`${label} payoffTiming "${String(hook.payoffTiming)}" -> ${resolved}`);
        hook.payoffTiming = resolved;
      } else {
        changes.push(`${label} payoffTiming "${String(hook.payoffTiming)}" dropped`);
        delete hook.payoffTiming;
      }
    }
  };

  const hookOps = root.hookOps as Record<string, unknown> | undefined;
  if (hookOps && Array.isArray(hookOps.upsert)) {
    hookOps.upsert.forEach((hook) => fix(hook, "upsert"));
  }
  if (Array.isArray(root.newHookCandidates)) {
    root.newHookCandidates.forEach((hook) => fix(hook, "new"));
  }
  return changes;
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}
