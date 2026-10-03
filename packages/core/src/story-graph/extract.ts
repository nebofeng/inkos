/**
 * Chapter → graph extraction: the LLM prompt/parser plus an offline
 * heuristic extractor (used for eval and zero-cost backfill).
 */
import { ChapterGraphExtractionSchema, type ChapterGraphExtraction, type ChapterGraphExtractor, type ChapterGraphExtractorInput } from "./types.js";
import { NameResolver } from "./truth.js";

export interface GraphLLMMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

/** Minimal completion interface so story-graph does not depend on a provider. */
export type GraphCompletion = (
  messages: ReadonlyArray<GraphLLMMessage>,
  options: { readonly temperature: number; readonly maxTokens: number },
) => Promise<string>;

export const STORY_GRAPH_PROMPT_VERSION = "story-graph-extract/v1";

export function buildExtractionMessages(input: ChapterGraphExtractorInput, maxChapterChars = 24_000): GraphLLMMessage[] {
  const isEn = input.language === "en";
  const roster = input.knownCharacters
    .slice(0, 60)
    .map((entry) => entry.aliases.length > 0 ? `${entry.name}（${entry.aliases.slice(0, 6).join("、")}）` : entry.name)
    .join("；");
  const content = input.content.length > maxChapterChars
    ? `${input.content.slice(0, maxChapterChars)}\n…(truncated)`
    : input.content;
  const schema = `{
  "characters": [{"name": "", "aliases": [""], "role": "", "status": "alive|dead|missing|unknown", "faction": "", "notes": ""}],
  "factions":   [{"name": "", "aliases": [""], "notes": ""}],
  "items":      [{"name": "", "aliases": [""], "owner": "", "notes": ""}],
  "locations":  [{"name": "", "aliases": [""], "notes": ""}],
  "events":     [{"summary": "", "participants": [""], "location": "", "importance": 1}],
  "relationships": [{"from": "", "to": "", "type": "", "strength": 0.5, "status": "active|ended", "note": ""}],
  "dialogues":  [{"speaker": "", "addressee": "", "quote": "", "context": ""}]
}`;
  const system = isEn
    ? [
        "You are InkOS's story knowledge-graph extractor. Read ONE chapter and record only what this chapter shows.",
        "Rules:",
        "- Use the canonical names from the known roster whenever a character matches (aliases, nicknames, titles). Put new nicknames seen in this chapter into aliases.",
        "- characters: everyone who appears or is materially discussed. status only when the chapter makes it explicit.",
        "- events: 3-8 plot-relevant events in chapter order, one sentence each, with participants. importance 3 = turning point, 1 = minor.",
        "- relationships: directed edges between characters (or character→faction) as of the END of this chapter. type is a short label of plain words without hyphens (ally, rival, mentor, owes debt, suspects…). strength 0-1. status=ended if the relationship broke or ended in this chapter.",
        "- dialogues: up to 8 key lines that later chapters may need to call back (promises, threats, secrets, reveals). quote MUST be copied verbatim from the chapter text, without the surrounding quotation marks. addressee may be empty.",
        "- Do not invent anything not in the chapter. Prefer fewer, accurate rows.",
        "Return strict JSON only (no prose), exactly this shape:",
        schema,
      ].join("\n")
    : [
        "你是 InkOS 的小说知识图谱抽取器。只读这一章，只记录本章正文里实际出现的内容。",
        "规则：",
        "- 角色能对上已知名单（含别名、外号、称谓）时一律用名单里的规范名；本章新出现的外号/称呼写进 aliases。",
        "- characters：本章出场或被实质提到的人物。status 只在正文明确交代生死/失踪时填写。",
        "- events：3-8 条推动剧情的事件，按发生顺序，一句话，写明参与者。importance 3=转折，1=小事。",
        "- relationships：截至本章结束时人物之间（或人物→势力）的有向关系。type 用简短标签（盟友、对手、师徒、欠债、怀疑……）。strength 取 0-1。本章关系破裂/结束则 status=ended。",
        "- dialogues：最多 8 句后文可能要回扣的关键台词（承诺、威胁、秘密、揭示）。quote 必须从正文逐字复制，不带外层引号；addressee 可留空。",
        "- 正文没有的不要编。宁少勿错。",
        "只返回严格 JSON（不要任何解释），格式如下：",
        schema,
      ].join("\n");
  const user = [
    isEn ? `Chapter ${input.chapterNumber}: ${input.title}` : `第${input.chapterNumber}章：${input.title}`,
    roster ? (isEn ? `Known roster: ${roster}` : `已知人物名单：${roster}`) : "",
    input.summaryHint ? (isEn ? `Chapter summary (for grounding only): ${input.summaryHint}` : `本章摘要（仅供对照）：${input.summaryHint}`) : "",
    "",
    isEn ? "Chapter text:" : "正文：",
    content,
  ].filter((line) => line !== "").join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export function parseExtractionResponse(raw: string): ChapterGraphExtraction {
  const trimmed = raw.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("story-graph extraction: no JSON object in model output");
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  }
  if (!parsed || typeof parsed !== "object") throw new Error("story-graph extraction: output is not an object");
  return ChapterGraphExtractionSchema.parse(normalizeRawExtraction(parsed as Record<string, unknown>));
}

const STATUS_ALIASES: Record<string, string> = {
  alive: "alive", living: "alive", 存活: "alive", 活着: "alive", 在世: "alive",
  dead: "dead", deceased: "dead", 死亡: "dead", 已死: "dead", 身亡: "dead", 阵亡: "dead",
  missing: "missing", 失踪: "missing", 下落不明: "missing",
  unknown: "unknown", 未知: "unknown",
};

function normalizeRawExtraction(raw: Record<string, unknown>): Record<string, unknown> {
  const rows = (key: string): Array<Record<string, unknown>> =>
    Array.isArray(raw[key]) ? (raw[key] as unknown[]).filter((row): row is Record<string, unknown> => !!row && typeof row === "object") : [];
  return {
    ...raw,
    characters: rows("characters").map((row) => ({
      ...row,
      status: typeof row.status === "string" ? STATUS_ALIASES[row.status.trim().toLowerCase()] ?? undefined : undefined,
      aliases: toStringList(row.aliases),
    })),
    factions: rows("factions").map((row) => ({ ...row, aliases: toStringList(row.aliases) })),
    items: rows("items").map((row) => ({ ...row, aliases: toStringList(row.aliases) })),
    locations: rows("locations").map((row) => ({ ...row, aliases: toStringList(row.aliases) })),
    events: rows("events").map((row) => ({ ...row, participants: toStringList(row.participants) })),
    relationships: rows("relationships").map((row) => ({
      ...row,
      strength: normalizeStrength(row.strength),
      status: typeof row.status === "string" && /end|结束|破裂|断/.test(row.status) ? "ended" : "active",
    })),
    dialogues: rows("dialogues").map((row) => ({
      ...row,
      addressee: typeof row.addressee === "string" && row.addressee.trim() ? row.addressee : undefined,
    })),
  };
}

function toStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (typeof value === "string" && value.trim()) return value.split(/[、,，;；/]/).map((part) => part.trim()).filter(Boolean);
  return undefined;
}

function normalizeStrength(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  if (n <= 1) return n;
  if (n <= 5) return n / 5;
  if (n <= 10) return n / 10;
  return 1;
}

export class LLMChapterGraphExtractor implements ChapterGraphExtractor {
  readonly id: string;

  constructor(
    private readonly complete: GraphCompletion,
    private readonly options: { readonly model?: string; readonly maxChapterChars?: number } = {},
  ) {
    this.id = `llm:${options.model ?? "default"}:${STORY_GRAPH_PROMPT_VERSION}`;
  }

  async extract(input: ChapterGraphExtractorInput): Promise<ChapterGraphExtraction> {
    const messages = buildExtractionMessages(input, this.options.maxChapterChars);
    const raw = await this.complete(messages, { temperature: 0.1, maxTokens: 4096 });
    return parseExtractionResponse(raw);
  }
}

/**
 * Offline extractor: no model call. Uses the truth roster to find characters,
 * paragraph co-occurrence for edges, the chapter summary for events and
 * quotation marks + nearest-name attribution for dialogue. Lower quality than
 * the LLM extractor, but deterministic and free — good for evals and for a
 * first backfill of long books.
 */
export class HeuristicChapterGraphExtractor implements ChapterGraphExtractor {
  readonly id = "heuristic:v1";

  async extract(input: ChapterGraphExtractorInput): Promise<ChapterGraphExtraction> {
    const resolver = new NameResolver(input.knownCharacters);
    const paragraphs = input.content.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const totals = resolver.findMentions(input.content);
    const characters = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([name]) => ({ name }));

    const pairCounts = new Map<string, number>();
    const dialogues: Array<{ speaker: string; addressee?: string; quote: string }> = [];
    for (const paragraph of paragraphs) {
      const present = [...resolver.findMentions(paragraph).keys()];
      for (let i = 0; i < present.length; i += 1) {
        for (let j = i + 1; j < present.length; j += 1) {
          const key = [present[i]!, present[j]!].sort().join("\u0000");
          pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
        }
      }
      for (const match of paragraph.matchAll(/[“「]([^”」]{4,160})[”」]/g)) {
        const before = paragraph.slice(Math.max(0, (match.index ?? 0) - 40), match.index ?? 0);
        const after = paragraph.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 16);
        const speaker = lastMention(resolver, before) ?? firstMention(resolver, after);
        if (!speaker) continue;
        const addressee = present.find((name) => name !== speaker);
        dialogues.push({ speaker, ...(addressee ? { addressee } : {}), quote: match[1]!.trim() });
      }
    }
    const relationships = [...pairCounts.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([key, count]) => {
        const [from, to] = key.split("\u0000") as [string, string];
        return { from, to, type: "同场", strength: Math.min(1, count / 6) };
      });

    const eventSource = input.summaryHint ?? "";
    const events = eventSource
      .split(/[；;。\n]/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 6)
      .slice(0, 8)
      .map((summary) => ({
        summary: summary.slice(0, 280),
        participants: [...resolver.findMentions(summary).keys()],
        importance: 2,
      }));

    // Keep the longest lines per speaker (likely the substantive ones).
    const picked = dialogues
      .sort((a, b) => b.quote.length - a.quote.length)
      .filter((line, index, all) => all.findIndex((other) => other.speaker === line.speaker) === index || index < 8)
      .slice(0, 10);

    return ChapterGraphExtractionSchema.parse({
      characters,
      factions: [],
      items: [],
      locations: [],
      events,
      relationships,
      dialogues: picked,
    });
  }
}

function lastMention(resolver: NameResolver, text: string): string | undefined {
  return resolver.lastMention(text);
}

function firstMention(resolver: NameResolver, text: string): string | undefined {
  if (!/(说|道|问|喊|笑|骂|答|叫|said|asked)/.test(text)) return undefined;
  return resolver.firstMention(text);
}
