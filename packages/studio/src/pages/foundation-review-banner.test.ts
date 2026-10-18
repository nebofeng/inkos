import { describe, expect, it } from "vitest";
import type { TFunction } from "../hooks/use-i18n";
import {
  foundationReviewBannerKind,
  foundationReviewBannerText,
  shouldShowFoundationReviewDot,
} from "./foundation-review-banner";

const t: TFunction = ((key: string) => {
  const map: Record<string, string> = {
    "book.foundationReviewWarning": "大纲 AI 审核未通过（{score}/{threshold}），已在重试后继续。建议先改大纲再连载。",
    "book.foundationReviewParseFailed": "大纲 AI 审核结果无法解析，已在重试后继续。建议先改大纲再连载。",
    "book.foundationReviewAcked": "已确认的大纲风险",
  };
  return map[key] ?? key;
}) as TFunction;

describe("foundation-review banner", () => {
  it("shows an alert banner for accepted-with-warning with dynamic score", () => {
    expect(foundationReviewBannerKind("accepted-with-warning")).toBe("alert");
    expect(shouldShowFoundationReviewDot("accepted-with-warning")).toBe(true);
    expect(foundationReviewBannerText({
      status: "accepted-with-warning",
      totalScore: 71,
      threshold: 80,
    }, t)).toBe("大纲 AI 审核未通过（71/80），已在重试后继续。建议先改大纲再连载。");
  });

  it("shows a parse-failed variant without scores", () => {
    expect(foundationReviewBannerKind("parse-failed")).toBe("alert");
    expect(foundationReviewBannerText({
      status: "parse-failed",
      totalScore: 0,
      threshold: 80,
    }, t)).toBe("大纲 AI 审核结果无法解析，已在重试后继续。建议先改大纲再连载。");
  });

  it("downgrades to a grey note after ack", () => {
    expect(foundationReviewBannerKind("acked")).toBe("acked");
    expect(shouldShowFoundationReviewDot("acked")).toBe(false);
    expect(foundationReviewBannerText({
      status: "acked",
      totalScore: 71,
      threshold: 80,
    }, t)).toBe("已确认的大纲风险");
  });

  it("hides the banner when the review passed", () => {
    expect(foundationReviewBannerKind("passed")).toBe("none");
    expect(shouldShowFoundationReviewDot("passed")).toBe(false);
    expect(shouldShowFoundationReviewDot(null)).toBe(false);
  });
});
