/**
 * Public types for `runDeAI`. Short-fiction (S7) should call this same function
 * after packaging `final/full.md` — do not fork a second pipeline.
 */

import type { AgentContext } from "../agents/base.js";
import type { BookConfig } from "../models/book.js";
import type { ProjectConfig } from "../models/project.js";
import type { QualityGateEvaluation } from "../quality-gate/evaluate.js";
import type { QualityGateChapterRecord } from "../quality-gate/persist.js";
import type { Logger } from "../utils/logger.js";
import type {
  DeAIConfigOverrides,
  EffectiveDeAIConfig,
  EffectiveExternalDetectConfig,
  ResolveDeAIBookInput,
  ResolveDeAIProjectInput,
} from "./config.js";

export type DeAIMode = "full" | "score-only";

/** Terminal statuses. `onFail=retry` is not a status — it means rewrite-then-judge. */
export type DeAIStatus = "ok" | "warned" | "skipped" | "failed";

export interface DeAIRewriteInput {
  readonly text: string;
  readonly previousText: string;
  readonly skill: string;
  readonly glossary: readonly string[];
  readonly targetWordCount: number | null;
  readonly attempt: number;
  readonly signal?: AbortSignal;
  readonly bookDir: string;
  readonly chapterNumber: number;
}

export type DeAIRewriter = (input: DeAIRewriteInput) => Promise<string>;

export interface DeAIExternalDetectInput {
  readonly text: string;
  readonly config: EffectiveExternalDetectConfig;
}

export type DeAIExternalDetectFn = (input: DeAIExternalDetectInput) => Promise<unknown>;

export interface DeAIInput {
  readonly bookId: string;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly minWords?: number;
  readonly text?: string;
  readonly previousText?: string;
  readonly mode?: DeAIMode;
  /** When set (audit-failed / state-degraded), forces score-only skip persist. */
  readonly skipReason?: string;
  readonly persist?: boolean;
  readonly persistDeAI?: boolean;
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
  readonly now?: () => string;
  readonly project?: ResolveDeAIProjectInput | ProjectConfig | null;
  readonly book?: ResolveDeAIBookInput | BookConfig | null;
  readonly preset?: string | null;
  readonly overrides?: DeAIConfigOverrides | null;
  readonly rewriter?: DeAIRewriter;
  readonly rewriteCtx?: AgentContext;
  readonly runExternalDetect?: DeAIExternalDetectFn;
  readonly glossary?: readonly string[];
  readonly genre?: string;
}

export interface DeAIChapterRecord {
  readonly chapterNumber: number;
  readonly status: DeAIStatus;
  readonly skipReason?: string;
  readonly passed: boolean;
  readonly score: number;
  readonly wordCount: number;
  readonly attempts: number;
  readonly rewritten: boolean;
  readonly skill: string;
  readonly reasons: readonly string[];
  readonly originalPath?: string;
  readonly evaluatedAt: string;
}

export interface DeAIFile {
  readonly bookId: string;
  readonly updatedAt: string;
  readonly chapters: DeAIChapterRecord[];
}

export interface DeAIResult {
  readonly status: DeAIStatus;
  readonly skipped: boolean;
  readonly skipReason?: string;
  readonly passed: boolean;
  readonly rewritten: boolean;
  readonly content: string;
  readonly originalContent: string;
  readonly score: number;
  readonly wordCount: number;
  readonly reasons: readonly string[];
  readonly attempts: number;
  readonly evaluation: QualityGateEvaluation;
  readonly record: QualityGateChapterRecord;
  readonly deaiRecord: DeAIChapterRecord;
  readonly config: EffectiveDeAIConfig;
  readonly jsonPath?: string;
  readonly deaiJsonPath?: string;
  readonly originalPath?: string;
}
