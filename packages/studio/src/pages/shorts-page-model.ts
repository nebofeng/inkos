export type ShortReviewState = "pending" | "confirmed" | "published";
export type ShortFilter = "all" | ShortReviewState;

export interface ShortListRow {
  readonly id: string;
  readonly title: string;
  readonly batch?: string;
  readonly source?: string;
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
    const haystack = [item.title, item.id, item.batch, item.source].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(q);
  });
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
