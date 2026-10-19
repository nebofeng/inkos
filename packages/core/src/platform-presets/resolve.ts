/**
 * Ported from WenlanAI backend/app/services/platform_presets.py (rev 3884ebf1b90922b439ae70004403dfd17a0bd5ca), GPL-3.0; combined into InkOS under AGPL-3.0 (GPL-3.0 §13).
 */

import { PLATFORM_PRESET_ALIASES, PLATFORM_PRESETS, PLATFORM_PRESET_IDS } from "./presets.js";
import type { PlatformPreset, PlatformPresetId, PlatformPresetRef } from "./types.js";

const FALLBACK_CHAPTER_WORDS = 3000;

export function listPlatformPresets(): PlatformPreset[] {
  return PLATFORM_PRESET_IDS.map((id) => PLATFORM_PRESETS[id]);
}

export function getPlatformPreset(id: string | undefined | null): PlatformPreset | undefined {
  const key = (id ?? "").trim().toLowerCase();
  if (!key) return undefined;
  return Object.prototype.hasOwnProperty.call(PLATFORM_PRESETS, key)
    ? PLATFORM_PRESETS[key as PlatformPresetId]
    : undefined;
}

export function resolvePlatformPreset(id: string | undefined | null): PlatformPreset | undefined {
  const key = (id ?? "").trim().toLowerCase();
  if (!key) return undefined;
  const canonical = PLATFORM_PRESET_ALIASES[key] ?? key;
  return getPlatformPreset(canonical);
}

export function resolveEffectivePlatformPreset(
  book?: PlatformPresetRef | null,
  project?: PlatformPresetRef | null,
): PlatformPreset | undefined {
  return resolvePlatformPreset(book?.platformPreset ?? project?.platformPreset);
}

export function withResolvedPlatformPreset<T extends PlatformPresetRef>(
  book: T,
  projectPreset?: string | null,
): T {
  const resolved = resolvePlatformPreset(book.platformPreset ?? projectPreset ?? undefined);
  if (!resolved) return book;
  if (book.platformPreset === resolved.id) return book;
  return { ...book, platformPreset: resolved.id };
}

export function platformPromptBlock(id: string | undefined | null): string {
  return resolvePlatformPreset(id)?.promptBlock ?? "";
}

export function defaultChapterWords(id: string | undefined | null, fallback = FALLBACK_CHAPTER_WORDS): number {
  return resolvePlatformPreset(id)?.chapterWords.target ?? fallback;
}

/**
 * Explicit chapterWordCount always wins. Preset target is used only when the
 * caller did not pass a length.
 */
export function resolveChapterWordCount(
  explicit: number | undefined,
  id?: string | null,
  fallback = FALLBACK_CHAPTER_WORDS,
): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
  return defaultChapterWords(id, fallback);
}

export interface ShortFictionPresetBounds {
  readonly shortForm: "chapters" | "answer";
  readonly chapterCount: { readonly default: number; readonly min: number; readonly max: number };
  readonly charsPerChapter?: { readonly default: number; readonly min: number; readonly max: number };
}

/** Answer-form short presets (zhihu-short, fanqie-short): override short-chain length defaults when the caller omitted them. */
export function resolveShortFictionPresetBounds(
  id: string | undefined | null,
  language: "zh" | "en" = "zh",
): ShortFictionPresetBounds | undefined {
  const preset = resolvePlatformPreset(id);
  if (preset?.shortForm !== "answer") return undefined;
  const shortForm = preset.shortForm === "answer" ? "answer" : "chapters";
  const chapterCount = shortForm === "answer"
    ? { default: 1, min: 1, max: 1 }
    : {
        default: preset.chapterCount?.defaultCount ?? 1,
        min: preset.chapterCount?.min ?? 1,
        max: preset.chapterCount?.max ?? 1,
      };
  if (language !== "zh") return { shortForm, chapterCount };
  return {
    shortForm,
    chapterCount,
    charsPerChapter: {
      default: preset.chapterWords.target,
      min: preset.chapterWords.min,
      max: preset.chapterWords.max,
    },
  };
}
