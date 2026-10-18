/**
 * Pure quality gate: AI-flavor score + word-count floor. No model calls.
 */

import { analyzeText } from "../ai-flavor/metrics.js";

export interface EvaluateQualityGateInput {
  readonly text: string;
  readonly previousText?: string;
  readonly minWords: number;
  readonly aiFlavorThreshold: number;
  readonly minWordRatio?: number;
}

export interface QualityGateEvaluation {
  readonly passed: boolean;
  readonly score: number;
  readonly wordCount: number;
  readonly reasons: string[];
}

export const DEFAULT_MIN_WORD_RATIO = 0.7;

export function countQualityGateWords(text: string): number {
  return (text || "").replace(/\s/g, "").length;
}

export function evaluateQualityGate(input: EvaluateQualityGateInput): QualityGateEvaluation {
  const text = input.text || "";
  const minWordRatio = input.minWordRatio ?? DEFAULT_MIN_WORD_RATIO;
  const metrics = analyzeText(text, input.previousText ?? "");
  const wordCount = countQualityGateWords(text);
  const reasons: string[] = [];

  if (metrics.score >= input.aiFlavorThreshold) {
    reasons.push(`AI 味分 ${metrics.score}（阈值 ${input.aiFlavorThreshold}）`);
  }

  const floor = input.minWords * minWordRatio;
  if (input.minWords > 0 && wordCount < floor) {
    const ratio = input.minWords > 0 ? wordCount / input.minWords : 0;
    reasons.push(`字数只有目标的 ${Math.round(ratio * 100)}%`);
  }

  return {
    passed: reasons.length === 0,
    score: metrics.score,
    wordCount,
    reasons,
  };
}
