import type { OpeningCheckItemId } from "./checklist.js";

export type OpeningCheckVerdict = "pass" | "fail" | "unverified";
export type OpeningHardGateMode = "hard" | "soft" | "disabled";

export interface OpeningCheckQuote {
  readonly text: string;
  readonly verified: boolean;
}

export interface BackgroundSpan {
  readonly chapterNumber: number;
  readonly charCount: number;
  readonly excerpt: string;
}

export interface OpeningCheckItemResult {
  readonly id: OpeningCheckItemId;
  readonly title: string;
  readonly criterion: string;
  readonly verdict: OpeningCheckVerdict;
  readonly quotes: string[];
  readonly quoteChecks: OpeningCheckQuote[];
  readonly suggestion: string;
  readonly backgroundSpans?: readonly BackgroundSpan[];
}

export interface OpeningHardGateBlock {
  readonly id: OpeningCheckItemId;
  readonly title: string;
  readonly verdict: OpeningCheckVerdict;
  readonly suggestion: string;
}

export interface OpeningHardGateResult {
  readonly passed: boolean;
  readonly mode: OpeningHardGateMode;
  readonly blocks: readonly OpeningHardGateBlock[];
  readonly reason?: string;
}

export interface OpeningCheckBinding {
  readonly service: string;
  readonly model: string;
}

export interface OpeningCheckChapter {
  readonly number: number;
  readonly body: string;
}

export interface OpeningCheckReport {
  readonly bookId: string;
  readonly chapters: readonly number[];
  readonly items: readonly OpeningCheckItemResult[];
  readonly generatedAt: string;
  readonly binding: OpeningCheckBinding;
  readonly skipped?: boolean;
  readonly skipReason?: string;
  readonly hardGate?: OpeningHardGateResult;
}

export interface OpeningCheckLlm {
  complete(input: { readonly system: string; readonly user: string }): Promise<string>;
}

export type OpeningCheckItemSeed = import("./checklist.js").OpeningCheckItemDef;
