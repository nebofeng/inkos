import { countChapterLength } from "../utils/length-metrics.js";
import { createRangeObservation, type ProductionObservation } from "../production/harness.js";
import type { ShortFictionBatchDraft, ShortFictionLanguage } from "../agents/short-fiction.js";
import type { ShortForm } from "./bounds.js";

const CHAPTER_MARKER = /(?:^|\n)\s*(?:#{1,6}\s*第\s*\d+\s*章|(?:第\s*\d+\s*章\s*[：:])|===\s*CHAPTER\s+\d+)/i;

export interface AnswerQualityInput {
  readonly markdown: string;
  readonly draft?: ShortFictionBatchDraft;
  readonly language: ShortFictionLanguage;
  readonly shortForm: ShortForm;
  readonly titleRequiredPrefix?: string;
  readonly targetChars: number;
  readonly minChars: number;
  readonly maxChars: number;
}

export function stripAnswerPrefixNoise(text: string): string {
  return text.replace(/^\s*#+\s*/, "").trimStart();
}

export function answerStartsWithPrefix(markdown: string, prefix: string | undefined): boolean {
  const required = prefix?.trim();
  if (!required) return true;
  return stripAnswerPrefixNoise(markdown).startsWith(required);
}

export function answerHasChapterMarkers(markdown: string): boolean {
  return CHAPTER_MARKER.test(markdown);
}

export function countAnswerChars(markdown: string, language: ShortFictionLanguage): number {
  return countChapterLength(markdown, language === "en" ? "en_words" : "zh_chars");
}

export function buildAnswerQualityObservations(input: AnswerQualityInput): ProductionObservation[] {
  if (input.shortForm !== "answer") return [];
  const actual = countAnswerChars(input.markdown, input.language);
  const prefixOk = answerStartsWithPrefix(input.markdown, input.titleRequiredPrefix);
  const noMarkers = !answerHasChapterMarkers(input.markdown);
  const observations: ProductionObservation[] = [
    createRangeObservation({
      metric: "final-length",
      actual,
      target: input.targetChars,
      min: input.minChars,
      max: input.maxChars,
      unit: input.language === "en" ? "en_words" : "zh_chars",
      evidence: "whole-piece answer (not per-chapter)",
      hard: true,
    }),
    {
      metric: "required-prefix",
      expected: input.titleRequiredPrefix?.trim() || "none",
      actual: prefixOk ? "ok" : "missing",
      severity: !input.titleRequiredPrefix?.trim() || prefixOk ? "info" : "warning",
      evidence: input.titleRequiredPrefix?.trim() || "",
      repairable: !prefixOk,
    },
    {
      metric: "no-chapter-markers",
      expected: "no chapter headings",
      actual: noMarkers ? "ok" : "found",
      severity: noMarkers ? "info" : "warning",
      evidence: noMarkers ? "" : "chapter marker in answer body",
      repairable: !noMarkers,
    },
  ];
  return observations;
}

export function renderAnswerMarkdown(draft: ShortFictionBatchDraft): string {
  return draft.chapters.map((chapter) => chapter.content.trim()).filter(Boolean).join("\n\n").trim() + "\n";
}
