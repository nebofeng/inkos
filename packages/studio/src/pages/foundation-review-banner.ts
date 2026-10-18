import type { TFunction } from "../hooks/use-i18n";
import type { FoundationReviewStatus } from "@actalk/inkos-core";

export interface FoundationReviewView {
  readonly status: FoundationReviewStatus | string;
  readonly passed: boolean;
  readonly totalScore: number;
  readonly threshold: number;
  readonly overallFeedback?: string;
  readonly userAck?: { readonly at: string; readonly by?: string } | null;
}

export type FoundationReviewBannerKind = "alert" | "acked" | "none";

export function foundationReviewBannerKind(
  status: string | null | undefined,
): FoundationReviewBannerKind {
  if (status === "accepted-with-warning" || status === "parse-failed") return "alert";
  if (status === "acked") return "acked";
  return "none";
}

export function foundationReviewBannerText(
  review: Pick<FoundationReviewView, "status" | "totalScore" | "threshold">,
  t: TFunction,
): string {
  if (review.status === "parse-failed") {
    return t("book.foundationReviewParseFailed");
  }
  if (review.status === "acked") {
    return t("book.foundationReviewAcked");
  }
  return t("book.foundationReviewWarning")
    .replace("{score}", String(review.totalScore))
    .replace("{threshold}", String(review.threshold));
}

export function shouldShowFoundationReviewDot(
  status: string | null | undefined,
): boolean {
  return foundationReviewBannerKind(status) === "alert";
}
