import { platformPromptBlock } from "../platform-presets/resolve.js";
import { formatRuleCardsLog, renderRuleCardsSection } from "./render.js";
import {
  resolveBookGenreNames,
  resolveRuleCardScopeLabel,
  selectRuleCards,
} from "./select.js";
import type { RuleCard, RuleCardStage } from "./schema.js";

export interface RuleCardsInfoLogger {
  readonly info?: (message: string, ctx?: Record<string, unknown>) => void;
}

export interface PickLongformRuleCardsInput {
  readonly cards: ReadonlyArray<RuleCard>;
  readonly stage: RuleCardStage;
  readonly chapterNumber: number;
  readonly totalChars?: number;
  readonly genre?: string | ReadonlyArray<string>;
  readonly logger?: RuleCardsInfoLogger;
}

/**
 * Select longform cards for a stage. Empty catalog → empty result and no log.
 * Non-empty catalog always logs `[rule-cards] ...` even when nothing is picked.
 */
export function pickLongformRuleCards(input: PickLongformRuleCardsInput): RuleCard[] {
  if (input.cards.length === 0) return [];

  const selected = selectRuleCards(input.cards, {
    stage: input.stage,
    mode: "long",
    chapterNumber: input.chapterNumber,
    totalChars: input.totalChars,
    genre: input.genre,
  });
  const scope = resolveRuleCardScopeLabel({
    mode: "long",
    chapterNumber: input.chapterNumber,
    totalChars: input.totalChars,
  });
  const genreNames = resolveBookGenreNames(input.genre);
  input.logger?.info?.(
    formatRuleCardsLog({
      stage: input.stage,
      scope,
      genre: genreNames.length > 0 ? genreNames : "all",
      cards: selected,
    }),
  );
  return selected;
}

/** Empty card set returns the original prompt unchanged. */
export function appendRuleCardsAfterPlatform(
  prompt: string,
  cards: ReadonlyArray<RuleCard> | undefined,
  platformPreset?: string | null,
): string {
  if (!cards || cards.length === 0) return prompt;
  const platformBlock = platformPromptBlock(platformPreset);
  return [prompt, platformBlock, renderRuleCardsSection(cards)].filter(Boolean).join("\n\n");
}

export function ruleCardsSection(cards: ReadonlyArray<RuleCard> | undefined): string {
  if (!cards || cards.length === 0) return "";
  return renderRuleCardsSection(cards);
}
