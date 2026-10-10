import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { estimateTextTokens } from "../llm/provider.js";
import type { ContextSource } from "../models/input-governance.js";
import { capContextBlock } from "./context-filter.js";
import { isProtectedContextSource } from "./context-assembly.js";

export const WRITE_CONTEXT_WINDOW_CAP = 128_000;
export const WRITE_CONTEXT_OVERHEAD_TOKENS = 4_000;

export const WriteContextProfileSchema = z.enum(["default", "longform-rag"]);
export type WriteContextProfile = z.infer<typeof WriteContextProfileSchema>;

export const WriteContextConfigSchema = z.object({
  profile: WriteContextProfileSchema.default("default"),
  windowCapTokens: z.number().int().min(8_000).max(2_000_000).default(WRITE_CONTEXT_WINDOW_CAP),
  autoConsolidateOnGuard: z.boolean().default(true),
  maxGuardRetries: z.number().int().min(0).max(5).default(2),
  predictiveThreshold: z.number().min(0.5).max(1).default(0.85),
});

export type WriteContextConfig = z.infer<typeof WriteContextConfigSchema>;

export const DEFAULT_WRITE_CONTEXT_CONFIG: WriteContextConfig = {
  profile: "default",
  windowCapTokens: WRITE_CONTEXT_WINDOW_CAP,
  autoConsolidateOnGuard: true,
  maxGuardRetries: 2,
  predictiveThreshold: 0.85,
};

export const LONGFORM_RAG_WRITE_CONTEXT_CONFIG: WriteContextConfig = {
  profile: "longform-rag",
  windowCapTokens: WRITE_CONTEXT_WINDOW_CAP,
  autoConsolidateOnGuard: true,
  maxGuardRetries: 2,
  predictiveThreshold: 0.85,
};

export type WriteContextBucket = "outline" | "memory" | "rag" | "hooks" | "other" | "protected";

export interface WriteContextBucketUsage {
  readonly outline: number;
  readonly memory: number;
  readonly rag: number;
  readonly hooks: number;
  readonly other: number;
  readonly protected: number;
}

export interface WriteContextDroppedSource {
  readonly source: string;
  readonly bucket: WriteContextBucket;
  readonly reason: string;
}

export interface WriteContextGuardEvent {
  readonly attempt: number;
  readonly step: WriteContextGuardStep;
  readonly reason: string;
}

export type WriteContextGuardStep =
  | "predictive_bucket"
  | "cap_and_shrink_rag"
  | "drop_compressible"
  | "consolidate";

export interface MemoryRetrievalLimits {
  readonly searchLimit: number;
  readonly recentSummaries: number;
  readonly recalledSummaries: number;
  readonly primaryHooks: number;
  readonly staleHooks: number;
  readonly facts: number;
  readonly volumeSummaries: number;
}

export interface WriteContextAttemptOptions {
  readonly attempt: number;
  readonly dropCompressibleTrails: boolean;
  readonly retrievalLimits: MemoryRetrievalLimits;
  readonly graphBudgetTokens: number;
  readonly graphHops: 1 | 2;
  readonly consolidateBeforeCompose: boolean;
}

export interface ResolvedWriteWindow {
  readonly modelContextWindow: number;
  readonly windowCapTokens: number;
  readonly contextWindowTokens: number;
  readonly reservedOutputTokens: number;
  readonly availableInputTokens: number;
}

const DEFAULT_RETRIEVAL_LIMITS: MemoryRetrievalLimits = {
  searchLimit: 32,
  recentSummaries: 3,
  recalledSummaries: 1,
  primaryHooks: 6,
  staleHooks: 2,
  facts: 4,
  volumeSummaries: 2,
};

const LONGFORM_RETRIEVAL_LIMITS: MemoryRetrievalLimits = {
  searchLimit: 24,
  recentSummaries: 3,
  recalledSummaries: 1,
  primaryHooks: 6,
  staleHooks: 2,
  facts: 4,
  volumeSummaries: 2,
};

export function resolveWriteContextConfig(
  projectRoot: string | undefined,
  book?: { readonly title?: string; readonly id?: string; readonly targetChapters?: number },
  env: NodeJS.ProcessEnv = process.env,
): WriteContextConfig {
  const file = projectRoot ? readWriteContextSection(projectRoot) : {};
  const parsed = WriteContextConfigSchema.catch(DEFAULT_WRITE_CONTEXT_CONFIG).parse(file);
  const jieyun = isJieyunBook(book);
  const longformHint = jieyun || (book?.targetChapters ?? 0) >= 200;
  const envRetries = parseIntEnv(env.INKOS_CONTEXT_MAX_GUARD_RETRIES);
  const envCap = parseIntEnv(env.INKOS_CONTEXT_WINDOW_CAP);
  return {
    profile: parsed.profile === "longform-rag" || longformHint ? "longform-rag" : parsed.profile,
    windowCapTokens: envCap ?? parsed.windowCapTokens,
    autoConsolidateOnGuard: parsed.autoConsolidateOnGuard,
    maxGuardRetries: envRetries ?? parsed.maxGuardRetries,
    predictiveThreshold: parsed.predictiveThreshold,
  };
}

export function isJieyunBook(book?: { readonly title?: string; readonly id?: string }): boolean {
  if (!book) return false;
  const haystack = `${book.title ?? ""} ${book.id ?? ""}`;
  return /劫云|jieyun|jie-yun/i.test(haystack);
}

export function resolveWriteWindow(params: {
  readonly modelContextWindow: number;
  readonly reservedOutputTokens: number;
  readonly windowCapTokens?: number;
  readonly configuredContextWindow?: number;
}): ResolvedWriteWindow {
  const modelContextWindow = Math.max(0, Math.floor(params.modelContextWindow));
  const configured = params.configuredContextWindow && params.configuredContextWindow > 0
    ? Math.floor(params.configuredContextWindow)
    : modelContextWindow;
  const windowCapTokens = Math.max(8_000, params.windowCapTokens ?? WRITE_CONTEXT_WINDOW_CAP);
  const contextWindowTokens = configured > 0
    ? Math.min(configured, windowCapTokens)
    : windowCapTokens;
  const reservedOutputTokens = Math.max(0, Math.floor(params.reservedOutputTokens));
  const rawAvailable = contextWindowTokens - reservedOutputTokens;
  const overhead = rawAvailable > WRITE_CONTEXT_OVERHEAD_TOKENS * 4
    ? WRITE_CONTEXT_OVERHEAD_TOKENS
    : 0;
  const availableInputTokens = Math.max(1, rawAvailable - overhead);
  return {
    modelContextWindow,
    windowCapTokens,
    contextWindowTokens,
    reservedOutputTokens,
    availableInputTokens,
  };
}

export function classifyWriteContextSource(source: string): WriteContextBucket {
  if (isProtectedContextSource(source)) return "protected";
  if (isOutlineSource(source)) return "outline";
  if (isHookSource(source)) return "hooks";
  if (isRagSource(source)) return "rag";
  if (isMemorySummarySource(source) || isMemoryFactSource(source)) return "memory";
  return "other";
}

export function estimateContextEntryTokens(entry: Pick<ContextSource, "source" | "reason" | "excerpt">): number {
  return estimateTextTokens([entry.source, entry.reason, entry.excerpt].filter(Boolean).join("\n"));
}

export function measureBucketUsage(entries: ReadonlyArray<ContextSource>): WriteContextBucketUsage {
  const usage: WriteContextBucketUsage = {
    outline: 0,
    memory: 0,
    rag: 0,
    hooks: 0,
    other: 0,
    protected: 0,
  };
  for (const entry of entries) {
    const bucket = classifyWriteContextSource(entry.source);
    usage[bucket] += estimateContextEntryTokens(entry);
  }
  return usage;
}

export function bucketBudgetsForAvailableTokens(availableInputTokens: number): Record<Exclude<WriteContextBucket, "protected">, number> {
  return {
    outline: Math.floor(availableInputTokens * 0.18),
    memory: Math.floor(availableInputTokens * 0.18),
    rag: Math.floor(availableInputTokens * 0.22),
    hooks: Math.floor(availableInputTokens * 0.12),
    other: Math.floor(availableInputTokens * 0.08),
  };
}

export function applyWriteContextBuckets(params: {
  readonly selectedContext: ReadonlyArray<ContextSource>;
  readonly availableInputTokens: number;
  readonly dropCompressibleTrails?: boolean;
}): {
  readonly selectedContext: ContextSource[];
  readonly bucketUsage: WriteContextBucketUsage;
  readonly dropped: WriteContextDroppedSource[];
  readonly notes: string[];
} {
  const dropped: WriteContextDroppedSource[] = [];
  const notes: string[] = [];
  let entries = params.selectedContext.map((entry) => ({ ...entry }));

  if (params.dropCompressibleTrails) {
    const next: ContextSource[] = [];
    for (const entry of entries) {
      if (isCompressibleTrailSource(entry.source)) {
        dropped.push({
          source: entry.source,
          bucket: classifyWriteContextSource(entry.source),
          reason: "drop-compressible-trails",
        });
        continue;
      }
      next.push(entry);
    }
    entries = next;
    if (dropped.length > 0) notes.push("dropped-compressible-trails");
  }

  const budgets = bucketBudgetsForAvailableTokens(params.availableInputTokens);
  const capped: ContextSource[] = [];
  const running: Record<Exclude<WriteContextBucket, "protected">, number> = {
    outline: 0,
    memory: 0,
    rag: 0,
    hooks: 0,
    other: 0,
  };

  for (const entry of entries) {
    const bucket = classifyWriteContextSource(entry.source);
    if (bucket === "protected") {
      capped.push(entry);
      continue;
    }
    const tokens = estimateContextEntryTokens(entry);
    const budget = budgets[bucket];
    if (running[bucket] + tokens <= budget) {
      running[bucket] += tokens;
      capped.push(entry);
      continue;
    }
    const remaining = Math.max(0, budget - running[bucket]);
    if (remaining < 80 || !entry.excerpt) {
      dropped.push({ source: entry.source, bucket, reason: "bucket-over-budget" });
      continue;
    }
    const cappedExcerpt = capContextBlock(entry.excerpt, {
      label: entry.source,
      maxChars: Math.max(40, remaining * 2),
    });
    const cappedEntry: ContextSource = { ...entry, excerpt: cappedExcerpt };
    const cappedTokens = estimateContextEntryTokens(cappedEntry);
    if (running[bucket] + cappedTokens > budget) {
      dropped.push({ source: entry.source, bucket, reason: "bucket-over-budget" });
      continue;
    }
    running[bucket] += cappedTokens;
    capped.push(cappedEntry);
    notes.push(`capped:${entry.source}`);
  }

  const bucketUsage = measureBucketUsage(capped);
  return {
    selectedContext: capped,
    bucketUsage,
    dropped,
    notes,
  };
}

export function shouldPredictivelyCompress(params: {
  readonly totalTokens: number;
  readonly availableInputTokens: number;
  readonly threshold: number;
}): boolean {
  if (params.availableInputTokens <= 0) return false;
  return params.totalTokens > Math.floor(params.availableInputTokens * params.threshold);
}

export function resolveWriteContextAttempt(
  config: WriteContextConfig,
  attempt: number,
): WriteContextAttemptOptions {
  const base = config.profile === "longform-rag" ? LONGFORM_RETRIEVAL_LIMITS : DEFAULT_RETRIEVAL_LIMITS;
  const step = Math.max(0, attempt);
  const shrink = (value: number, floor: number) => Math.max(floor, Math.floor(value / (step + 1)));
  return {
    attempt: step,
    dropCompressibleTrails: step >= 1,
    retrievalLimits: {
      searchLimit: shrink(base.searchLimit, 8),
      recentSummaries: shrink(base.recentSummaries, 1),
      recalledSummaries: step >= 2 ? 0 : base.recalledSummaries,
      primaryHooks: shrink(base.primaryHooks, 3),
      staleHooks: step >= 2 ? 0 : shrink(base.staleHooks, 0),
      facts: shrink(base.facts, 2),
      volumeSummaries: shrink(base.volumeSummaries, 1),
    },
    graphBudgetTokens: step === 0 ? 1200 : step === 1 ? 600 : 400,
    graphHops: step === 0 ? 2 : 1,
    consolidateBeforeCompose: config.autoConsolidateOnGuard && step >= 2,
  };
}

export function nextGuardStep(attempt: number, autoConsolidate: boolean): WriteContextGuardStep {
  if (attempt <= 0) return "predictive_bucket";
  if (attempt === 1) return "cap_and_shrink_rag";
  return autoConsolidate ? "consolidate" : "drop_compressible";
}

export function isContextWindowGuardError(error: unknown): boolean {
  if (!error) return false;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "ContextWindowExceededError") return true;
  return /context window guard|context[_ ]window|maximum context length|prompt is too long|over-window|too many tokens/i.test(message);
}

export function buildWriteContextTrace(params: {
  readonly window: ResolvedWriteWindow;
  readonly bucketUsage: WriteContextBucketUsage;
  readonly dropped: ReadonlyArray<WriteContextDroppedSource>;
  readonly predictiveCompression: boolean;
  readonly guardEvents?: ReadonlyArray<WriteContextGuardEvent>;
}): {
  readonly windowTokens: number;
  readonly reservedOutputTokens: number;
  readonly availableInputTokens: number;
  readonly bucketUsage: WriteContextBucketUsage;
  readonly dropped: WriteContextDroppedSource[];
  readonly predictiveCompression: boolean;
  readonly reactiveRetries: number;
  readonly guardEvents: WriteContextGuardEvent[];
} {
  return {
    windowTokens: params.window.contextWindowTokens,
    reservedOutputTokens: params.window.reservedOutputTokens,
    availableInputTokens: params.window.availableInputTokens,
    bucketUsage: params.bucketUsage,
    dropped: [...params.dropped],
    predictiveCompression: params.predictiveCompression,
    reactiveRetries: params.guardEvents?.length ?? 0,
    guardEvents: [...(params.guardEvents ?? [])],
  };
}

function isOutlineSource(source: string): boolean {
  return source.includes("outline/")
    || source.includes("story_bible")
    || source.includes("volume_outline")
    || source.includes("story_frame")
    || source.includes("volume_map");
}

function isHookSource(source: string): boolean {
  return source.includes("pending_hooks") || source.includes("hook_debt");
}

function isRagSource(source: string): boolean {
  return source.startsWith("story/graph#") || source.startsWith("reference/");
}

function isMemorySummarySource(source: string): boolean {
  return source.includes("chapter_summaries") || source.includes("volume_summaries");
}

function isMemoryFactSource(source: string): boolean {
  return source.startsWith("story/current_state.md#");
}

function isCompressibleTrailSource(source: string): boolean {
  return source.includes("#recent_titles")
    || source.includes("#recent_mood_type_trail")
    || source.includes("#recent_endings")
    || source === "story/chapters#recent_endings";
}

function readWriteContextSection(projectRoot: string): unknown {
  try {
    const raw = JSON.parse(readFileSync(join(projectRoot, "inkos.json"), "utf-8")) as {
      context?: unknown;
    };
    return raw.context ?? {};
  } catch {
    return {};
  }
}

function parseIntEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
