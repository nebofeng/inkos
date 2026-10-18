import { OPENING_CHECK_ITEMS, openingCheckItemById } from "./checklist.js";
import type { OpeningCheckItemResult, OpeningCheckVerdict } from "./types.js";

export interface ParsedOpeningCheckItem {
  readonly id: number;
  readonly verdict: "pass" | "fail";
  readonly quotes: string[];
  readonly suggestion: string;
}

export function extractJsonValue(raw: string): unknown {
  const trimmed = (raw || "").trim();
  if (!trimmed) throw new Error("opening-check: empty model response");

  const unfenced = stripFence(trimmed);
  try {
    return JSON.parse(unfenced);
  } catch {
    const startObj = unfenced.indexOf("{");
    const startArr = unfenced.indexOf("[");
    const start = startObj >= 0 && (startArr < 0 || startObj < startArr) ? startObj : startArr;
    if (start < 0) throw new Error("opening-check: model response is not JSON");
    const closer = unfenced[start] === "[" ? "]" : "}";
    const end = unfenced.lastIndexOf(closer);
    if (end <= start) throw new Error("opening-check: model response is not JSON");
    return JSON.parse(unfenced.slice(start, end + 1));
  }
}

function stripFence(text: string): string {
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence?.[1]) return fence[1].trim();
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

export function parseOpeningCheckResponse(raw: string): ParsedOpeningCheckItem[] {
  let value: unknown;
  try {
    value = extractJsonValue(raw);
  } catch {
    return [];
  }

  const records = collectRecords(value);
  const byId = new Map<number, ParsedOpeningCheckItem>();
  for (const record of records) {
    const parsed = parseRecord(record);
    if (!parsed) continue;
    if (!byId.has(parsed.id)) byId.set(parsed.id, parsed);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function collectRecords(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.items)) return obj.items;
    if (Array.isArray(obj.results)) return obj.results;
  }
  return [];
}

function parseRecord(value: unknown): ParsedOpeningCheckItem | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const id = Number(obj.id);
  if (!Number.isInteger(id) || !openingCheckItemById(id)) return undefined;
  const verdict = normalizeModelVerdict(obj.verdict ?? obj.result ?? obj.status);
  if (!verdict) return undefined;
  return {
    id,
    verdict,
    quotes: normalizeQuotes(obj.quotes ?? obj.evidence ?? obj.citations),
    suggestion: typeof obj.suggestion === "string"
      ? obj.suggestion.trim()
      : typeof obj.fix === "string"
        ? obj.fix.trim()
        : "",
  };
}

function normalizeModelVerdict(value: unknown): "pass" | "fail" | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (["pass", "ok", "passed", "通过", "达标"].includes(v)) return "pass";
  if (["fail", "failed", "no", "不通过", "未通过", "失败", "标红"].includes(v)) return "fail";
  return undefined;
}

function normalizeQuotes(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function fillChecklistItems(
  parsed: readonly ParsedOpeningCheckItem[],
): OpeningCheckItemResult[] {
  const byId = new Map(parsed.map((item) => [item.id, item]));
  return OPENING_CHECK_ITEMS.map((def) => {
    const hit = byId.get(def.id);
    if (!hit) {
      return {
        id: def.id,
        title: def.title,
        criterion: def.criterion,
        verdict: "unverified" as const,
        quotes: [],
        quoteChecks: [],
        suggestion: "模型未返回该条，需人工复核。",
      };
    }
    return {
      id: def.id,
      title: def.title,
      criterion: def.criterion,
      verdict: hit.verdict,
      quotes: hit.quotes,
      quoteChecks: hit.quotes.map((text) => ({ text, verified: false })),
      suggestion: hit.suggestion,
    };
  });
}

export function applyQuoteVerification(
  items: readonly OpeningCheckItemResult[],
  body: string,
  verify: (quote: string, body: string) => boolean,
): OpeningCheckItemResult[] {
  return items.map((item) => {
    const quoteChecks = item.quotes.map((text) => ({
      text,
      verified: verify(text, body),
    }));
    const hasQuotes = quoteChecks.length > 0;
    const allUnverified = hasQuotes && quoteChecks.every((q) => !q.verified);
    const verdict: OpeningCheckVerdict = allUnverified ? "unverified" : item.verdict;
    return {
      ...item,
      quoteChecks,
      verdict,
    };
  });
}
