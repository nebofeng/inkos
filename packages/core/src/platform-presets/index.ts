/**
 * Ported from WenlanAI backend/app/services/platform_presets.py (rev 3884ebf1b90922b439ae70004403dfd17a0bd5ca), GPL-3.0; combined into InkOS under AGPL-3.0 (GPL-3.0 §13).
 */

export {
  PLATFORM_PRESET_ALIASES,
  PLATFORM_PRESET_IDS,
  PLATFORM_PRESETS,
} from "./presets.js";
export {
  defaultChapterWords,
  getPlatformPreset,
  listPlatformPresets,
  platformPromptBlock,
  resolveChapterWordCount,
  resolveEffectivePlatformPreset,
  resolvePlatformPreset,
  resolveShortFictionPresetBounds,
  withResolvedPlatformPreset,
  type ShortFictionPresetBounds,
} from "./resolve.js";
export type {
  ChapterCountRange,
  ChapterWordRange,
  PlatformPreset,
  PlatformPresetId,
  PlatformPresetRef,
  ShortForm,
} from "./types.js";
