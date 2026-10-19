/** 「我的创作」侧栏：类别同级只保留长篇/短篇，展开后最多预览 5 条最近作品。 */

export const SIDEBAR_PREVIEW_LIMIT = 5;

export const CREATE_PREVIEW_CATEGORY_IDS = ["longform", "shorts"] as const;
export type CreatePreviewCategoryId = (typeof CREATE_PREVIEW_CATEGORY_IDS)[number];

export interface CreatePreviewItem {
  readonly id: string;
  readonly title: string;
  readonly createdAt?: string | number;
  readonly updatedAt?: string | number;
  readonly batch?: string;
}

export interface CreatePreviewBucket<T> {
  readonly id: CreatePreviewCategoryId;
  readonly items: ReadonlyArray<T>;
  readonly total: number;
  readonly hasMore: boolean;
}

export interface CreatePreviewModel<TBook extends CreatePreviewItem, TShort extends CreatePreviewItem> {
  /** 与类别同级的入口，不含书名/短篇名。 */
  readonly categoryIds: readonly ["longform", "shorts"];
  readonly longform: CreatePreviewBucket<TBook>;
  readonly shorts: CreatePreviewBucket<TShort>;
}

export function parseRecency(value: string | number | undefined | null): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function itemRecency(item: CreatePreviewItem): number | undefined {
  return parseRecency(item.updatedAt) ?? parseRecency(item.createdAt) ?? parseRecency(item.batch);
}

export function takeRecentPreview<T>(
  items: ReadonlyArray<T>,
  recencyOf: (item: T) => number | undefined,
  limit = SIDEBAR_PREVIEW_LIMIT,
): T[] {
  const capped = Math.max(0, limit);
  return items
    .map((item, index) => ({ item, index, recency: recencyOf(item) }))
    .sort((a, b) => {
      const aKnown = a.recency !== undefined;
      const bKnown = b.recency !== undefined;
      if (aKnown && bKnown && a.recency !== b.recency) {
        return (b.recency as number) - (a.recency as number);
      }
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      return a.index - b.index;
    })
    .slice(0, capped)
    .map((entry) => entry.item);
}

function toBucket<T>(
  id: CreatePreviewCategoryId,
  items: ReadonlyArray<T>,
  recencyOf: (item: T) => number | undefined,
  limit: number,
): CreatePreviewBucket<T> {
  return {
    id,
    items: takeRecentPreview(items, recencyOf, limit),
    total: items.length,
    hasMore: items.length > limit,
  };
}

export function buildCreatePreview<TBook extends CreatePreviewItem, TShort extends CreatePreviewItem>(input: {
  readonly books: ReadonlyArray<TBook>;
  readonly shorts: ReadonlyArray<TShort>;
  readonly limit?: number;
}): CreatePreviewModel<TBook, TShort> {
  const limit = input.limit ?? SIDEBAR_PREVIEW_LIMIT;
  return {
    categoryIds: CREATE_PREVIEW_CATEGORY_IDS,
    longform: toBucket("longform", input.books, itemRecency, limit),
    shorts: toBucket("shorts", input.shorts, itemRecency, limit),
  };
}
