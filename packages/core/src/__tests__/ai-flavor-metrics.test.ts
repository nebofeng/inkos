import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  analyzeText,
  flaggedParagraphIndices,
  splitParagraphs,
  toSnakeCaseMetrics,
} from "../ai-flavor/metrics.js";

interface FixtureCase {
  readonly id: string;
  readonly text: string;
  readonly previousText: string;
  readonly targetWordCount: number | null;
  readonly expected: Record<string, unknown>;
}

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ai-flavor-metrics.json");
const fixtures = JSON.parse(readFileSync(fixturePath, "utf-8")) as FixtureCase[];

describe("ai-flavor metrics vs WenlanAI python fixture", () => {
  it("has python-generated cases", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(8);
  });

  for (const fixture of fixtures) {
    it(`matches python analyze_text for ${fixture.id}`, () => {
      const actual = analyzeText(fixture.text, fixture.previousText, fixture.targetWordCount);
      expect(toSnakeCaseMetrics(actual)).toEqual(fixture.expected);
      expect(flaggedParagraphIndices(splitParagraphs(fixture.text))).toEqual(fixture.expected.flagged_paragraphs);
    });
  }
});

describe("ai-flavor paragraph split", () => {
  it("splits by line and drops blank lines, matching python", () => {
    expect(splitParagraphs("甲\n\n  乙  \n\n")).toEqual(["甲", "乙"]);
  });
});
