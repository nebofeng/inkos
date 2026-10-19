export type ShortReviewState = "pending" | "confirmed" | "published";
export type ShortFilter = "all" | ShortReviewState;

export interface ShortListRow {
  readonly id: string;
  readonly title: string;
  readonly batch?: string;
  readonly source?: string;
  readonly platform?: string;
  readonly charCount: number;
  readonly productionStatus?: string;
  readonly reviewState: string;
  readonly answerUrl?: string | null;
  readonly finalPath: string;
}

export function isShortReviewState(value: string): value is ShortReviewState {
  return value === "pending" || value === "confirmed" || value === "published";
}

export function filterShorts(
  items: ReadonlyArray<ShortListRow>,
  filter: ShortFilter,
  query = "",
): ShortListRow[] {
  const q = query.trim().toLowerCase();
  return items.filter((item) => {
    if (filter !== "all" && item.reviewState !== filter) return false;
    if (!q) return true;
    const haystack = [item.title, item.id, item.batch, item.source, item.platform].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(q);
  });
}

const PLATFORM_CHAR_BOUNDS: Record<string, { min: number; max: number }> = {
  zhihu: { min: 2200, max: 3500 },
  "zhihu-short": { min: 2200, max: 3500 },
  fanqie: { min: 10000, max: 30000 },
  "fanqie-short": { min: 10000, max: 30000 },
};

export function shortCharBounds(platform?: string): { min: number; max: number } {
  return PLATFORM_CHAR_BOUNDS[platform ?? ""] ?? { min: 2200, max: 3500 };
}

export function shortCharHint(count: number, min = 2200, max = 3500): {
  readonly inRange: boolean;
  readonly label: string;
} {
  const inRange = count >= min && count <= max;
  return {
    inRange,
    label: `${count} / ${min}–${max}`,
  };
}

export function canConfirm(state: string): boolean {
  return state === "pending";
}

export function canReturn(state: string): boolean {
  return state === "confirmed";
}

export function canRegisterPublished(state: string): boolean {
  return state === "confirmed";
}

export function isFinalReadOnly(state: string): boolean {
  return state === "published";
}

export function isValidAnswerUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function shortPlatformPresetWords(platform?: string): number {
  const bounds = shortCharBounds(platform);
  // Default to round mid-range target
  if (platform?.includes("fanqie")) return 15000;
  return Math.round((bounds.min + bounds.max) / 2 / 100) * 100;
}

export function buildRewritePrompt(selectedText?: string): string {
  if (selectedText?.trim()) {
    return `请改写选中的这段内容，优化文风、增强张力，并提供替换后的全文修改版本：\n\n"${selectedText.trim()}"`;
  }
  return "请重点改写本篇短篇的开头段落，增强开篇悬念与吸引力，并提供修改后的全文版本。";
}

export function buildDeAIPrompt(): string {
  return "请对全文进行去AI味润色，消除AI常用的生硬句式、刻板过渡词与空洞套话，增强更真实自然的文学质感与人物口语呼吸感。";
}

export function buildExpandPrompt(targetWords: number): string {
  return `请将这篇短篇扩写至约 ${targetWords} 字，增加人物细腻的动作、心理描写与环境细节，丰富情节冲突，但不要注水。`;
}

export function buildCondensePrompt(targetWords: number): string {
  return `请将这篇短篇精简压缩至约 ${targetWords} 字，删减冗余枝节与拖沓修饰，强化核心主线与关键对白，使叙事节奏更加紧凑有力。`;
}

