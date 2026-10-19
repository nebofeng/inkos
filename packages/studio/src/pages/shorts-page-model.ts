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
