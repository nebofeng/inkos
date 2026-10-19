import { resolvePlatformPreset, resolveShortFictionPresetBounds } from "../platform-presets/index.js";

/** Absolute ceiling for short-run length fields in schemas (covers fanqie-short 10000-30000). */
export const SHORT_RUN_LENGTH_ABS_MAX = 30000;

const DEFAULT_CHAPTERS = { min: 12, max: 18, default: 12 } as const;
const DEFAULT_ZH_CHARS = { min: 900, max: 1200, default: 1000 } as const;
const DEFAULT_EN_WORDS = { min: 600, max: 800, default: 650 } as const;

export type ShortForm = "chapters" | "answer";

export interface ShortFictionFormContext {
  readonly platformPreset?: string;
  readonly shortForm?: ShortForm;
  readonly titleRequiredPrefix?: string;
  readonly zhihuQuestion?: string;
  readonly minChars?: number;
  readonly maxChars?: number;
}

export interface ShortRunLengthInput {
  readonly platformPreset?: string | null;
  readonly language?: "zh" | "en";
  readonly chapterCount?: number;
  readonly charsPerChapter?: number;
  readonly totalChars?: number;
  readonly minChars?: number;
  readonly maxChars?: number;
}

export interface ShortRunCharRange {
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

export interface ResolvedShortRunLength {
  readonly shortForm: ShortForm;
  readonly platformPreset?: string;
  readonly chapterCount: number;
  readonly chapterCountBounds: { readonly min: number; readonly max: number; readonly default: number };
  readonly charsPerChapter: number;
  readonly targetChars: number;
  readonly minChars: number;
  readonly maxChars: number;
}

export function resolveShortForm(platformPreset?: string | null): ShortForm {
  return resolvePlatformPreset(platformPreset)?.shortForm === "answer" ? "answer" : "chapters";
}

export function shortRunCharRange(input: {
  readonly language?: "zh" | "en";
  readonly platformPreset?: string | null;
}): ShortRunCharRange {
  const language = input.language ?? "zh";
  if (language === "en") {
    return {
      min: DEFAULT_EN_WORDS.min,
      max: DEFAULT_EN_WORDS.max,
      default: DEFAULT_EN_WORDS.default,
    };
  }
  const preset = resolveShortFictionPresetBounds(input.platformPreset, language);
  if (preset?.charsPerChapter) {
    return {
      min: preset.charsPerChapter.min,
      max: preset.charsPerChapter.max,
      default: preset.charsPerChapter.default,
    };
  }
  return {
    min: DEFAULT_ZH_CHARS.min,
    max: DEFAULT_ZH_CHARS.max,
    default: DEFAULT_ZH_CHARS.default,
  };
}

export function shortRunChapterRange(input: {
  readonly platformPreset?: string | null;
  readonly language?: "zh" | "en";
}): { readonly min: number; readonly max: number; readonly default: number } {
  const preset = resolveShortFictionPresetBounds(input.platformPreset, input.language ?? "zh");
  if (preset?.chapterCount) return preset.chapterCount;
  return {
    min: DEFAULT_CHAPTERS.min,
    max: DEFAULT_CHAPTERS.max,
    default: DEFAULT_CHAPTERS.default,
  };
}

export function resolveShortRunLength(input: ShortRunLengthInput): ResolvedShortRunLength {
  const language = input.language ?? "zh";
  const shortForm = resolveShortForm(input.platformPreset);
  const chapterBounds = shortRunChapterRange({ platformPreset: input.platformPreset, language });
  const charRange = shortRunCharRange({ platformPreset: input.platformPreset, language });
  const minChars = input.minChars ?? charRange.min;
  const maxChars = input.maxChars ?? charRange.max;
  if (minChars > maxChars) {
    throw new Error(`minChars=${minChars} is greater than maxChars=${maxChars}`);
  }
  const target = input.totalChars ?? input.charsPerChapter ?? charRange.default;
  const chapterCount = shortForm === "answer"
    ? 1
    : clampOrThrow(input.chapterCount ?? chapterBounds.default, chapterBounds.min, chapterBounds.max, "chapterCount");
  const charsPerChapter = clampOrThrow(target, minChars, maxChars, shortForm === "answer" ? "totalChars" : "charsPerChapter");
  return {
    shortForm,
    ...(input.platformPreset ? { platformPreset: input.platformPreset } : {}),
    chapterCount,
    chapterCountBounds: shortForm === "answer" ? { min: 1, max: 1, default: 1 } : chapterBounds,
    charsPerChapter,
    targetChars: charsPerChapter,
    minChars,
    maxChars,
  };
}

function clampOrThrow(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name}=${value} is outside the valid range (${min}-${max})`);
  }
  return value;
}
