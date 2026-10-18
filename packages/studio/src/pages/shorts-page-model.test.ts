import { describe, expect, it } from "vitest";
import {
  canConfirm,
  canRegisterPublished,
  canReturn,
  filterShorts,
  isFinalReadOnly,
  isValidAnswerUrl,
  shortCharHint,
  type ShortListRow,
} from "./shorts-page-model";

const rows: ShortListRow[] = [
  { id: "a", title: "将军愿降否", batch: "2026-10-13", source: "import", charCount: 2957, reviewState: "pending", finalPath: "final/zhihu-answer.md" },
  { id: "b", title: "每日新身份", batch: "2026-10-14", source: "import", charCount: 2880, reviewState: "published", finalPath: "final/zhihu-answer.md" },
  { id: "c", title: "废后", batch: "2026-10-12", source: "inkos", charCount: 3093, reviewState: "confirmed", finalPath: "final/zhihu-answer.md" },
];

describe("shorts page model", () => {
  it("filters by review state and title query", () => {
    expect(filterShorts(rows, "published").map((row) => row.id)).toEqual(["b"]);
    expect(filterShorts(rows, "all", "将军").map((row) => row.id)).toEqual(["a"]);
    expect(filterShorts(rows, "pending", "废后")).toEqual([]);
  });

  it("shows whole-piece 2200-3500 char hint", () => {
    expect(shortCharHint(2800)).toEqual({ inRange: true, label: "2800 / 2200–3500" });
    expect(shortCharHint(1200).inRange).toBe(false);
  });

  it("gates confirm / return / publish and published read-only", () => {
    expect(canConfirm("pending")).toBe(true);
    expect(canConfirm("confirmed")).toBe(false);
    expect(canReturn("confirmed")).toBe(true);
    expect(canRegisterPublished("confirmed")).toBe(true);
    expect(canRegisterPublished("pending")).toBe(false);
    expect(isFinalReadOnly("published")).toBe(true);
    expect(isFinalReadOnly("pending")).toBe(false);
  });

  it("requires an http(s) answer url", () => {
    expect(isValidAnswerUrl("https://www.zhihu.com/question/1/answer/2")).toBe(true);
    expect(isValidAnswerUrl("not a url")).toBe(false);
    expect(isValidAnswerUrl("")).toBe(false);
  });
});
