import { HooksStateSchema } from "../models/runtime-state.js";
import type { RuntimeStateSnapshot } from "../state/state-reducer.js";
import { renderHooksProjection } from "../state/state-projections.js";
import { rerunPromotionPass } from "../utils/hook-promotion.js";
import { parsePendingHooksMarkdown, renderHookSnapshot } from "../utils/story-markdown.js";

export interface HookPromotionInput {
  readonly updatedHooks: string;
  readonly runtimeStateSnapshot?: RuntimeStateSnapshot;
}

export interface HookPromotionResult {
  readonly updated: boolean;
  readonly flippedCount: number;
  readonly updatedHooks: string;
  readonly runtimeStateSnapshot?: RuntimeStateSnapshot;
}

/**
 * Post-chapter promotion pass (seed -> live ledger).
 *
 * When the chapter produced a structured runtime-state snapshot, that snapshot
 * is the source of truth: promote on its hooks directly and re-render the
 * ledger from it. Re-parsing the rendered markdown instead loses information
 * (status cells such as "deferred (受阻于 H001 (已阻 8 章))", truncated cells)
 * and then overwrote the snapshot hooks with the lossy copy.
 * Without a snapshot (legacy settlement), fall back to the markdown ledger.
 */
export function applyChapterHookPromotion(
  output: HookPromotionInput,
  summariesMarkdown: string,
  language: "zh" | "en",
  chapterNumber: number,
): HookPromotionResult {
  const snapshot = output.runtimeStateSnapshot;
  if (snapshot) {
    const promotion = rerunPromotionPass(snapshot.hooks.hooks, summariesMarkdown);
    if (!promotion.updated) {
      return { updated: false, flippedCount: 0, updatedHooks: output.updatedHooks, runtimeStateSnapshot: snapshot };
    }
    const hooks = HooksStateSchema.parse({ hooks: [...promotion.hooks] });
    return {
      updated: true,
      flippedCount: promotion.flippedCount,
      updatedHooks: renderHooksProjection(hooks, language, { currentChapter: chapterNumber }),
      runtimeStateSnapshot: { ...snapshot, hooks },
    };
  }

  const promotion = rerunPromotionPass(parsePendingHooksMarkdown(output.updatedHooks), summariesMarkdown);
  return {
    updated: promotion.updated,
    flippedCount: promotion.flippedCount,
    updatedHooks: promotion.updated
      ? renderHookSnapshot([...promotion.hooks], language)
      : output.updatedHooks,
  };
}
