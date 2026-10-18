/**
 * Ported from WenlanAI backend/app/services/deai_rewrite.py
 * (rev 3884ebf1b90922b439ae70004403dfd17a0bd5ca), GPL-3.0;
 * combined into InkOS under AGPL-3.0 (GPL-3.0 §13).
 *
 * Local rewrite: send only flagged paragraphs to the model, merge in place,
 * leave every other paragraph byte-identical. Missing glossary terms revert
 * that paragraph to the original.
 */

import { analyzeText, splitParagraphs, type AiFlavorMetrics } from "./metrics.js";
import { glossaryTermsMissing } from "./glossary.js";
import {
  DEFAULT_DEAI_PROMPTS,
  buildLocalRewritePrompt,
  mergeParagraphs,
  parseLocalRewrite,
} from "./rewrite-prompt.js";

export interface LocalRewriteLlm {
  complete(prompt: string): Promise<string>;
}

export interface LocalRewriteInput {
  readonly text: string;
  readonly previousText?: string;
  readonly targetWordCount?: number | null;
  readonly glossary?: readonly string[];
  readonly prompts?: readonly string[];
  readonly llm: LocalRewriteLlm;
}

export interface LocalRewriteResult {
  readonly merged: string;
  readonly changedIndices: readonly number[];
  readonly revertedIndices: readonly number[];
  readonly skippedIndices: readonly number[];
  readonly flaggedParagraphs: readonly number[];
  readonly before: AiFlavorMetrics;
  readonly after: AiFlavorMetrics;
}

export async function rewriteFlaggedParagraphs(input: LocalRewriteInput): Promise<LocalRewriteResult> {
  const text = input.text ?? "";
  const glossary = input.glossary ?? [];
  const before = analyzeText(text, input.previousText, input.targetWordCount);
  const flagged = before.flaggedParagraphs;
  if (flagged.length === 0 || !text.trim()) {
    return {
      merged: text,
      changedIndices: [],
      revertedIndices: [],
      skippedIndices: [],
      flaggedParagraphs: flagged,
      before,
      after: before,
    };
  }

  const paragraphs = splitParagraphs(text);
  const prompt = buildLocalRewritePrompt(
    input.prompts ?? DEFAULT_DEAI_PROMPTS,
    paragraphs,
    flagged,
    glossary,
  );

  let parsed = new Map<number, string>();
  try {
    const raw = await input.llm.complete(prompt);
    parsed = parseLocalRewrite(raw, flagged);
  } catch {
    parsed = new Map();
  }

  const replacements = new Map<number, string>();
  const changed: number[] = [];
  const reverted: number[] = [];
  const skipped: number[] = [];

  for (const index of flagged) {
    const next = parsed.get(index);
    const original = paragraphs[index] ?? "";
    if (!next || next === original) {
      skipped.push(index);
      continue;
    }
    const missing = glossaryTermsMissing(original, next, glossary);
    if (missing.length > 0) {
      reverted.push(index);
      continue;
    }
    replacements.set(index, next);
    changed.push(index);
  }

  const merged = replacements.size > 0 ? mergeParagraphs(text, replacements) : text;
  const after = analyzeText(merged, input.previousText, input.targetWordCount);
  return {
    merged,
    changedIndices: changed,
    revertedIndices: reverted,
    skippedIndices: skipped,
    flaggedParagraphs: flagged,
    before,
    after,
  };
}

export function assertUnflaggedParagraphsUnchanged(
  original: string,
  merged: string,
  flagged: readonly number[],
): void {
  const before = splitParagraphs(original);
  const after = splitParagraphs(merged);
  if (before.length !== after.length) {
    throw new Error(`local-rewrite changed paragraph count ${before.length} → ${after.length}`);
  }
  const flaggedSet = new Set(flagged);
  for (let i = 0; i < before.length; i++) {
    if (flaggedSet.has(i)) continue;
    if (before[i] !== after[i]) {
      throw new Error(`local-rewrite mutated unflagged paragraph [${i}]`);
    }
  }
}
