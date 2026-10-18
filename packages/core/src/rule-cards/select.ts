import type { RuleCard, RuleCardPriority, RuleCardScope, RuleCardStage } from "./schema.js";

export const RULE_CARD_EARLY_CHAR_LIMIT = 30_000;
export const RULE_CARD_SELECT_MIN = 5;
export const RULE_CARD_SELECT_MAX = 10;

/**
 * Genre id → Chinese name used on rule cards.
 * Profile `name` values (玄幻/仙侠/都市) take precedence when the caller
 * already passes them; ids are mapped through this table.
 */
export const RULE_CARD_GENRE_ID_TO_NAME: Readonly<Record<string, string>> = {
  xuanhuan: "玄幻",
  xianxia: "仙侠",
  urban: "都市",
  chuanyue: "穿越",
  isekai: "穿越",
  chongsheng: "重生",
  gaowu: "高武",
  system: "系统",
  yule: "娱乐",
  zhihu: "知乎",
};

const PRIORITY_RANK: Record<RuleCardPriority, number> = {
  high: 0,
  mid: 1,
  low: 2,
};

export type RuleCardMode = "long" | "short";
export type RuleCardScopeLabel = "opening" | "early" | "any" | "short";

export interface SelectRuleCardsInput {
  readonly stage: RuleCardStage;
  readonly mode: RuleCardMode;
  readonly chapterNumber?: number;
  readonly totalChars?: number;
  readonly genre?: string | ReadonlyArray<string>;
  readonly min?: number;
  readonly max?: number;
}

export function resolveRuleCardScopeLabel(input: {
  readonly mode: RuleCardMode;
  readonly chapterNumber?: number;
  readonly totalChars?: number;
}): RuleCardScopeLabel {
  if (input.mode === "short") return "short";
  if (isOpeningChapter(input.chapterNumber)) return "opening";
  if (isEarlyWordCount(input.totalChars)) return "early";
  return "any";
}

export function resolveRuleCardScopes(input: {
  readonly mode: RuleCardMode;
  readonly chapterNumber?: number;
  readonly totalChars?: number;
}): ReadonlyArray<RuleCardScope> {
  switch (resolveRuleCardScopeLabel(input)) {
    case "short":
      return ["short", "opening", "any"];
    case "opening":
      return ["opening", "early", "any"];
    case "early":
      return ["early", "any"];
    default:
      return ["any"];
  }
}

export function canonicalizeGenreToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return "";
  if (trimmed.toLowerCase() === "all") return "all";
  const mapped = RULE_CARD_GENRE_ID_TO_NAME[trimmed.toLowerCase()];
  return mapped ?? trimmed;
}

export function resolveBookGenreNames(genre: string | ReadonlyArray<string> | undefined): string[] {
  const raw = Array.isArray(genre) ? genre : genre ? [genre] : [];
  const names = new Set<string>();
  for (const item of raw) {
    const canonical = canonicalizeGenreToken(item);
    if (canonical && canonical !== "all") names.add(canonical);
  }
  return [...names].sort((a, b) => a.localeCompare(b, "zh"));
}

export function selectRuleCards(
  cards: ReadonlyArray<RuleCard>,
  input: SelectRuleCardsInput,
): RuleCard[] {
  const max = Math.max(1, input.max ?? RULE_CARD_SELECT_MAX);
  const min = Math.min(max, Math.max(0, input.min ?? RULE_CARD_SELECT_MIN));
  const scopes = new Set(resolveRuleCardScopes(input));
  const bookGenres = new Set(resolveBookGenreNames(input.genre));

  const stageMatched = cards.filter((card) => card.stage.includes(input.stage));
  const scoped = stageMatched.filter((card) => card.scope.some((scope) => scopes.has(scope)));
  const genreMatched = scoped.filter((card) => matchesBookGenre(card, bookGenres));

  const scopeLabel = resolveRuleCardScopeLabel(input);
  const ranked = sortRuleCards(genreMatched, bookGenres, scopeLabel);
  const selected = ranked.slice(0, max);

  if (selected.length >= min) {
    return selected;
  }

  const picked = new Set(selected.map((card) => card.id));
  const fillers = sortRuleCards(
    stageMatched.filter((card) => {
      if (picked.has(card.id)) return false;
      if (card.priority !== "high") return false;
      return card.genre.some((token) => canonicalizeGenreToken(token) === "all");
    }),
    bookGenres,
    scopeLabel,
  );

  for (const card of fillers) {
    selected.push(card);
    picked.add(card.id);
    if (selected.length >= min) break;
  }

  return selected;
}

function isOpeningChapter(chapterNumber: number | undefined): boolean {
  return chapterNumber !== undefined && chapterNumber >= 1 && chapterNumber <= 3;
}

function isEarlyWordCount(totalChars: number | undefined): boolean {
  return totalChars !== undefined && totalChars < RULE_CARD_EARLY_CHAR_LIMIT;
}

function matchesBookGenre(card: RuleCard, bookGenres: Set<string>): boolean {
  let hasAll = false;
  for (const token of card.genre) {
    const canonical = canonicalizeGenreToken(token);
    if (canonical === "all") {
      hasAll = true;
      continue;
    }
    if (bookGenres.has(canonical)) return true;
  }
  return hasAll;
}

function isExactGenreHit(card: RuleCard, bookGenres: Set<string>): boolean {
  if (bookGenres.size === 0) return false;
  return card.genre.some((token) => {
    const canonical = canonicalizeGenreToken(token);
    return canonical !== "all" && bookGenres.has(canonical);
  });
}

function sortRuleCards(
  cards: ReadonlyArray<RuleCard>,
  bookGenres: Set<string>,
  scopeLabel: RuleCardScopeLabel,
): RuleCard[] {
  return [...cards].sort((a, b) => {
    const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (byPriority !== 0) return byPriority;
    const aExact = isExactGenreHit(a, bookGenres) ? 0 : 1;
    const bExact = isExactGenreHit(b, bookGenres) ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    const byScope = scopeSpecificity(a, scopeLabel) - scopeSpecificity(b, scopeLabel);
    if (byScope !== 0) return byScope;
    return a.id.localeCompare(b.id);
  });
}

function scopeSpecificity(card: RuleCard, label: RuleCardScopeLabel): number {
  const scopes = new Set(card.scope);
  if (label === "short") {
    if (scopes.has("short")) return 0;
    if (scopes.has("opening")) return 1;
    return 2;
  }
  if (label === "opening") {
    if (scopes.has("opening")) return 0;
    if (scopes.has("early")) return 1;
    return 2;
  }
  if (label === "early") {
    if (scopes.has("early")) return 0;
    return 1;
  }
  return 0;
}
