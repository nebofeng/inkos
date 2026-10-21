import {
  OPENING_HARD_GATE_IDS,
  openingCheckItemById,
  type OpeningCheckItemId,
} from "./checklist.js";
import type {
  OpeningCheckItemResult,
  OpeningCheckReport,
  OpeningCheckVerdict,
  OpeningHardGateBlock,
  OpeningHardGateMode,
  OpeningHardGateResult,
} from "./types.js";

export interface OpeningCheckOverride {
  readonly enabled?: boolean;
  readonly hardGate?: boolean;
}

export function resolveOpeningCheckEnabled(
  project?: OpeningCheckOverride,
  book?: OpeningCheckOverride,
): boolean {
  if (book?.enabled !== undefined) return book.enabled;
  if (project?.enabled !== undefined) return project.enabled;
  return true;
}

export function resolveOpeningCheckHardGate(
  project?: OpeningCheckOverride,
  book?: OpeningCheckOverride,
): boolean {
  if (book?.hardGate !== undefined) return book.hardGate;
  if (project?.hardGate !== undefined) return project.hardGate;
  return true;
}

export function deriveHardGateItems(
  items: readonly OpeningCheckItemResult[],
): OpeningCheckItemResult[] {
  const byId = new Map(items.map((item) => [String(item.id), item]));
  const combined = byId.get("5");
  const fiveA = byId.get("5a");
  const fiveB = byId.get("5b");

  const next = items.map((item) => {
    if (item.id === "5a" && item.verdict === "unverified" && combined && combined.verdict !== "unverified" && !fiveAHasOwnVerdict(fiveA)) {
      return copyVerdict(item, combined);
    }
    if (item.id === "5b" && item.verdict === "unverified" && combined && combined.verdict !== "unverified" && !fiveBHasOwnVerdict(fiveB)) {
      return copyVerdict(item, combined);
    }
    return item;
  });

  const derivedA = next.find((item) => item.id === "5a");
  const derivedB = next.find((item) => item.id === "5b");
  if (!derivedA || !derivedB) return next;

  return next.map((item) => {
    if (item.id !== 5) return item;
    if (item.verdict !== "unverified" && fiveAHasOwnVerdict(fiveA) === false && fiveBHasOwnVerdict(fiveB) === false) {
      return item;
    }
    const combinedVerdict = combineSplitVerdicts(derivedA.verdict, derivedB.verdict);
    if (combinedVerdict === item.verdict) return item;
    return {
      ...item,
      verdict: combinedVerdict,
      suggestion: item.suggestion.trim()
        ? item.suggestion
        : [derivedA.suggestion, derivedB.suggestion].filter((text) => text.trim()).join("；"),
      quotes: item.quotes.length > 0 ? item.quotes : uniqueQuotes(derivedA.quotes, derivedB.quotes),
      quoteChecks: item.quoteChecks.length > 0
        ? item.quoteChecks
        : [...derivedA.quoteChecks, ...derivedB.quoteChecks],
    };
  });
}

function fiveAHasOwnVerdict(item: OpeningCheckItemResult | undefined): boolean {
  return Boolean(item && item.verdict !== "unverified");
}

function fiveBHasOwnVerdict(item: OpeningCheckItemResult | undefined): boolean {
  return Boolean(item && item.verdict !== "unverified");
}

function copyVerdict(target: OpeningCheckItemResult, source: OpeningCheckItemResult): OpeningCheckItemResult {
  return {
    ...target,
    verdict: source.verdict,
    quotes: target.quotes.length > 0 ? target.quotes : source.quotes,
    quoteChecks: target.quoteChecks.length > 0 ? target.quoteChecks : source.quoteChecks,
    suggestion: target.suggestion.trim() ? target.suggestion : source.suggestion,
  };
}

function combineSplitVerdicts(a: OpeningCheckVerdict, b: OpeningCheckVerdict): OpeningCheckVerdict {
  if (a === "fail" || b === "fail") return "fail";
  if (a === "unverified" || b === "unverified") return "unverified";
  return "pass";
}

function uniqueQuotes(...groups: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    for (const quote of group) {
      if (seen.has(quote)) continue;
      seen.add(quote);
      out.push(quote);
    }
  }
  return out;
}

export function evaluateOpeningHardGate(
  report: Pick<OpeningCheckReport, "items" | "skipped" | "skipReason" | "hardGate">,
  config?: { readonly enabled?: boolean; readonly hardGate?: boolean },
): OpeningHardGateResult {
  if (config?.enabled === false || report.skipped) {
    return {
      passed: true,
      mode: "disabled",
      blocks: [],
      reason: report.skipReason ?? "开篇检查已关闭（openingCheck.enabled=false），硬闸未启用",
    };
  }

  const mode: OpeningHardGateMode = config?.hardGate === false ? "soft" : "hard";
  const blocks = collectHardGateBlocks(report.items);
  const blocking = blocks.filter((block) => block.verdict !== "pass");
  const passed = mode === "soft" || blocking.length === 0;
  return {
    passed,
    mode,
    blocks,
    reason: blocking.length === 0
      ? undefined
      : formatOpeningHardGateFailure(blocking, mode),
  };
}

export function collectHardGateBlocks(
  items: readonly OpeningCheckItemResult[],
): OpeningHardGateBlock[] {
  const byId = new Map(items.map((item) => [String(item.id), item]));
  return OPENING_HARD_GATE_IDS.map((id) => {
    const def = openingCheckItemById(id);
    const hit = byId.get(String(id));
    return {
      id,
      title: hit?.title ?? def?.title ?? String(id),
      verdict: hit?.verdict ?? "unverified",
      suggestion: hit?.suggestion ?? (hit ? "" : "缺硬挡判定，需先跑开篇检查。"),
    };
  });
}

export function formatOpeningHardGateFailure(
  blocks: readonly OpeningHardGateBlock[],
  mode: OpeningHardGateMode = "hard",
): string {
  const failed = blocks.filter((block) => block.verdict !== "pass");
  if (failed.length === 0) return "";
  const titles = failed.map((block) => `${hardGateLabel(block.id)}（${verdictLabel(block.verdict)}）`).join("、");
  const prefix = mode === "soft" ? "开篇硬挡未通过（软闸，不挡发）" : "开篇硬闸未通过";
  return `${prefix}：${titles}`;
}

export function hardGateLabel(id: OpeningCheckItemId): string {
  if (id === "5a" || id === 5) return "无金手指";
  if (id === "5b") return "黄金500字内无钩";
  if (id === 7) return "无当面小boss";
  const def = openingCheckItemById(id);
  return def?.title ?? String(id);
}

function verdictLabel(verdict: OpeningCheckVerdict): string {
  if (verdict === "pass") return "通过";
  if (verdict === "fail") return "不通过";
  return "未核验";
}

export class OpeningHardGateError extends Error {
  readonly code = "OPENING_HARD_GATE";
  readonly evaluation: OpeningHardGateResult;

  constructor(evaluation: OpeningHardGateResult) {
    super(evaluation.reason ?? "开篇硬闸未通过");
    this.name = "OpeningHardGateError";
    this.evaluation = evaluation;
  }
}

export function isOpeningHardGateError(error: unknown): error is OpeningHardGateError {
  return error instanceof OpeningHardGateError;
}
