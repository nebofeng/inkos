import { describe, expect, it } from "vitest";
import {
  openingCheckDisplayItems,
  openingHardGateBlocked,
  type OpeningCheckReportView,
} from "./opening-check-panel";

describe("opening-check panel helpers", () => {
  it("keeps numeric checklist rows and hides 5a/5b splits", () => {
    const report: OpeningCheckReportView = {
      items: [
        { id: 5, title: "金手指", verdict: "fail" },
        { id: "5a", title: "金手指", verdict: "fail" },
        { id: "5b", title: "黄金500字钩", verdict: "pass" },
        { id: 7, title: "前期小 boss", verdict: "pass" },
      ],
    };
    expect(openingCheckDisplayItems(report).map((item) => item.id)).toEqual([5, 7]);
  });

  it("blocks publish only in hard mode", () => {
    expect(openingHardGateBlocked({ passed: false, mode: "hard", blocks: [] })).toBe(true);
    expect(openingHardGateBlocked({ passed: false, mode: "soft", blocks: [] })).toBe(false);
    expect(openingHardGateBlocked({ passed: true, mode: "hard", blocks: [] })).toBe(false);
  });
});
