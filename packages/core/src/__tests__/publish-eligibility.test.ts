import { describe, expect, it } from "vitest";
import { computePublishEligible, filterPublishPool } from "../pipeline/publish-eligibility.js";
import type { ChapterMeta } from "../models/chapter.js";

function chapter(overrides: Partial<ChapterMeta>): ChapterMeta {
  return {
    number: 1,
    title: "t",
    status: "ready-for-review",
    wordCount: 1,
    createdAt: "2026-10-09T00:00:00.000Z",
    updatedAt: "2026-10-09T00:00:00.000Z",
    auditIssues: [],
    lengthWarnings: [],
    ...overrides,
  };
}

describe("publish eligibility", () => {
  it("requires deslop ok/skipped and detectionPassed true", () => {
    expect(computePublishEligible({ deslopStatus: "ok", detectionPassed: true })).toBe(true);
    expect(computePublishEligible({ deslopStatus: "skipped", detectionPassed: true })).toBe(true);
    expect(computePublishEligible({ deslopStatus: "ok", detectionPassed: false })).toBe(false);
    expect(computePublishEligible({ deslopStatus: "failed", detectionPassed: true })).toBe(false);
    expect(computePublishEligible({ deslopStatus: "ok" })).toBe(false);
    expect(computePublishEligible({})).toBe(false);
    expect(computePublishEligible({
      deslopStatus: "ok",
      detectionPassed: true,
      openingHardGatePassed: false,
    })).toBe(false);
    expect(computePublishEligible({
      deslopStatus: "ok",
      detectionPassed: true,
      openingHardGatePassed: true,
    })).toBe(true);
  });

  it("filters the publish pool and treats missing fields as ineligible", () => {
    const pool = filterPublishPool([
      chapter({ number: 1 }),
      chapter({ number: 2, publishEligible: false }),
      chapter({ number: 3, publishEligible: true }),
    ]);
    expect(pool.map((item) => item.number)).toEqual([3]);
  });
});
