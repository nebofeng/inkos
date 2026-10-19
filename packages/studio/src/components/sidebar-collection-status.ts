export type CollectionListStatus = "error" | "empty" | "ready";

export function collectionListStatus(error: string | null | undefined, total: number): CollectionListStatus {
  if (error) return "error";
  if (total === 0) return "empty";
  return "ready";
}
