/**
 * Story-graph feature flag + tunables.
 *
 * Resolution order (first hit wins per field):
 *   1. env  INKOS_STORY_GRAPH=1|0, INKOS_STORY_GRAPH_BUDGET=<tokens>,
 *           INKOS_STORY_GRAPH_HOPS=1|2, INKOS_STORY_GRAPH_EXTRACTOR=llm|heuristic
 *   2. inkos.json  { "memory": { "graph": { "enabled": true, ... } } }
 *   3. defaults (enabled: false)
 *
 * The raw inkos.json is read directly (not via ProjectConfigSchema) so the
 * feature stays isolated from the shared config model.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_VECTOR_CONFIG, type StoryGraphVectorConfig } from "./vector.js";

export interface StoryGraphConfig {
  readonly enabled: boolean;
  /** Token budget for graph context injected into the writer (default 1200). */
  readonly budgetTokens: number;
  /** Relationship hops to expand from key characters (1 or 2, default 2). */
  readonly hops: 1 | 2;
  /** Max characters (seeds + neighbours) to include (default 8). */
  readonly maxCharacters: number;
  /** Max dialogue lines in the context (default 6). */
  readonly maxDialogues: number;
  /** Recent events per seed character (default 3; neighbours get 1). */
  readonly eventsPerCharacter: number;
  /** "llm" (default) or "heuristic" (offline, no model call). */
  readonly extractor: "llm" | "heuristic";
  /** Chapter text cap sent to the extractor (default 24000 chars). */
  readonly maxChapterChars: number;
  /**
   * After writing chapter N, also re-extract up to this many earlier chapters
   * whose text changed since extraction (revisions). Never extracts chapters
   * that were not extracted before — use the backfill command for that.
   */
  readonly refreshStaleLimit: number;
  /** Optional semantic retrieval (OpenAI-compatible /embeddings); off by default. */
  readonly vector: StoryGraphVectorConfig;
}

export const DEFAULT_STORY_GRAPH_CONFIG: StoryGraphConfig = {
  enabled: false,
  budgetTokens: 1200,
  hops: 2,
  maxCharacters: 8,
  maxDialogues: 6,
  eventsPerCharacter: 3,
  extractor: "llm",
  maxChapterChars: 24_000,
  refreshStaleLimit: 1,
  vector: DEFAULT_VECTOR_CONFIG,
};

export function resolveStoryGraphConfig(
  projectRoot: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): StoryGraphConfig {
  const file = projectRoot ? readGraphSection(projectRoot) : {};
  const pick = <K extends keyof StoryGraphConfig>(key: K, parse: (value: unknown) => StoryGraphConfig[K] | undefined, envValue?: string) =>
    (envValue !== undefined && envValue !== "" ? parse(envValue) : undefined)
    ?? parse(file[key])
    ?? DEFAULT_STORY_GRAPH_CONFIG[key];

  return {
    enabled: pick("enabled", parseBool, env.INKOS_STORY_GRAPH),
    budgetTokens: pick("budgetTokens", intIn(200, 8000), env.INKOS_STORY_GRAPH_BUDGET),
    hops: pick("hops", (value) => {
      const n = intIn(1, 2)(value);
      return n === 1 || n === 2 ? n : undefined;
    }, env.INKOS_STORY_GRAPH_HOPS),
    maxCharacters: pick("maxCharacters", intIn(1, 20)),
    maxDialogues: pick("maxDialogues", intIn(0, 20)),
    eventsPerCharacter: pick("eventsPerCharacter", intIn(0, 10)),
    extractor: pick("extractor", (value) => (value === "llm" || value === "heuristic" ? value : undefined), env.INKOS_STORY_GRAPH_EXTRACTOR),
    maxChapterChars: pick("maxChapterChars", intIn(2000, 100_000)),
    refreshStaleLimit: pick("refreshStaleLimit", intIn(0, 5)),
    vector: pick("vector", parseVector),
  };
}

function readGraphSection(projectRoot: string): Partial<Record<keyof StoryGraphConfig, unknown>> {
  try {
    const raw = JSON.parse(readFileSync(join(projectRoot, "inkos.json"), "utf-8")) as {
      memory?: { graph?: Record<string, unknown> };
    };
    const graph = raw?.memory?.graph;
    return graph && typeof graph === "object" ? graph as Partial<Record<keyof StoryGraphConfig, unknown>> : {};
  } catch {
    return {};
  }
}

function parseBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  return undefined;
}

function intIn(min: number, max: number) {
  return (value: unknown): number | undefined => {
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isFinite(n)) return undefined;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
}

function parseVector(value: unknown): StoryGraphVectorConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const str = (key: string) => (typeof raw[key] === "string" && (raw[key] as string).trim() ? (raw[key] as string).trim() : undefined);
  return {
    enabled: raw.enabled === true,
    ...(str("baseUrl") ? { baseUrl: str("baseUrl") } : {}),
    ...(str("model") ? { model: str("model") } : {}),
    ...(str("apiKeyEnv") ? { apiKeyEnv: str("apiKeyEnv") } : {}),
    ...(typeof raw.dimensions === "number" ? { dimensions: raw.dimensions } : {}),
  };
}
