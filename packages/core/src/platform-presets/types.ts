/**
 * Ported from WenlanAI backend/app/services/platform_presets.py (rev 3884ebf1b90922b439ae70004403dfd17a0bd5ca), GPL-3.0; combined into InkOS under AGPL-3.0 (GPL-3.0 §13).
 */

export type PlatformPresetId = "qidian" | "fanqie" | "jjwxc" | "qimao" | "zhihu-short";

export interface ChapterWordRange {
  readonly target: number;
  readonly min: number;
  readonly max: number;
}

export interface ChapterCountRange {
  readonly min: number;
  readonly max: number;
  /** Suggested band, e.g. 3–8. */
  readonly recommendedMin: number;
  readonly recommendedMax: number;
  /** Default when the caller did not pass chapterCount (mid of recommended). */
  readonly defaultCount: number;
}

export interface PlatformPreset {
  readonly id: PlatformPresetId;
  readonly name: string;
  readonly chapterWords: ChapterWordRange;
  readonly chapterCount?: ChapterCountRange;
  readonly aiFlavorThreshold: number;
  readonly promptBlock: string;
}

export interface PlatformPresetRef {
  readonly platformPreset?: string;
}
