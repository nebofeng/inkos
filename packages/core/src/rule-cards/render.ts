import type { RuleCard, RuleCardStage } from "./schema.js";

export const RULE_CARD_RENDER_CHAR_LIMIT = 200;

export interface RuleCardChecklistItem {
  readonly cardId: string;
  readonly pass: boolean;
  readonly evidence: string;
}

export interface FormatRuleCardsLogInput {
  readonly stage: RuleCardStage | string;
  readonly scope: string;
  readonly genre: string | ReadonlyArray<string>;
  readonly cards: ReadonlyArray<Pick<RuleCard, "id">>;
}

const PASS_TOKENS = new Set(["是", "通过", "yes", "y", "true", "pass", "ok"]);
const FAIL_TOKENS = new Set(["否", "不通过", "no", "n", "false", "fail"]);

export function renderRuleCardsSection(cards: ReadonlyArray<RuleCard>): string {
  const blocks = cards.map((card) => truncateChars(renderCardBlock(card), RULE_CARD_RENDER_CHAR_LIMIT));
  return ["【规则卡】", ...blocks].join("\n");
}

export function renderRuleCardsChecklist(cards: ReadonlyArray<RuleCard>): string {
  const lines = [
    "【规则卡清单】",
    "请对下列每张规则卡逐条输出一行：<cardId>: 是/否 | <证据>",
  ];
  for (const card of cards) {
    lines.push(`- ${card.id}: ${card.check}`);
  }
  return lines.join("\n");
}

export function parseRuleCardChecklist(text: string): RuleCardChecklistItem[] {
  const found = new Map<string, RuleCardChecklistItem>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = parseChecklistLine(line);
    if (!parsed) continue;
    if (!found.has(parsed.cardId)) {
      found.set(parsed.cardId, parsed);
    }
  }
  return [...found.values()];
}

export function formatRuleCardsLog(input: FormatRuleCardsLogInput): string {
  const genre = formatGenreLabel(input.genre);
  const picked = input.cards.map((card) => card.id).join(",");
  return `[rule-cards] stage=${input.stage} scope=${input.scope} genre=${genre} picked=${picked}`;
}

function formatGenreLabel(genre: string | ReadonlyArray<string>): string {
  if (typeof genre === "string") return genre.trim() || "all";
  return genre.length > 0 ? genre.join("+") : "all";
}

function renderCardBlock(card: RuleCard): string {
  const lines = [`[${card.id}]${card.title ? ` ${card.title}` : ""}`, `规则：${card.rule}`];
  if (card.good) lines.push(`好：${card.good}`);
  if (card.bad) lines.push(`坏：${card.bad}`);
  return lines.join("\n");
}

function truncateChars(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max).join("");
}

function parseChecklistLine(line: string): RuleCardChecklistItem | null {
  const stripped = line.replace(/^[-*]\s+/, "");
  const match = stripped.match(
    /(?:cardId\s*[=:：]\s*)?([A-Za-z][A-Za-z0-9]*-\d+)\s*[:：,，|｜]?\s*(不通过|通过|yes|no|pass|fail|true|false|是|否)(?=$|[\s|｜:：,，])/i,
  );
  if (!match || match.index === undefined) return null;

  const verdict = match[2].toLowerCase();
  const pass = PASS_TOKENS.has(verdict) || PASS_TOKENS.has(match[2]);
  const fail = FAIL_TOKENS.has(verdict) || FAIL_TOKENS.has(match[2]);
  if (!pass && !fail) return null;

  const evidence = stripped
    .slice(match.index + match[0].length)
    .replace(/^[\s|｜:：,，\-—]+/, "")
    .trim();

  return {
    cardId: match[1].toUpperCase(),
    pass,
    evidence,
  };
}
