import type { AuditIssue } from "../agents/continuity.js";
import type {
  ValidationResult,
  ValidationWarning,
} from "../agents/state-validator.js";
import type { StateValidatorAgent } from "../agents/state-validator.js";
import type { WriteChapterOutput } from "../agents/writer.js";
import type { WriterAgent } from "../agents/writer.js";
import type { Logger } from "../utils/logger.js";
import type { BookConfig } from "../models/book.js";
import type { ChapterMeta } from "../models/chapter.js";
import type { ContextPackage, RuleStack } from "../models/input-governance.js";
import type { LengthLanguage } from "../utils/length-metrics.js";
import { parsePendingHooksMarkdown } from "../utils/story-markdown.js";

/** Settlement re-runs after the first validation failure (1 = InkOS 1.8.0 behavior). */
export const DEFAULT_SETTLEMENT_RETRY_ATTEMPTS = 1;
const MAX_SETTLEMENT_RETRY_ATTEMPTS = 5;
const MAX_PREVIOUS_DELTA_CHARS = 12_000;

/**
 * Resolve how many times the settlement may be regenerated after the state
 * validator rejects it: explicit value, else INKOS_STATE_VALIDATION_RETRIES,
 * else 1. Clamped to 1..5.
 */
export function resolveSettlementRetryAttempts(
  explicit?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = explicit ?? (env.INKOS_STATE_VALIDATION_RETRIES ? Number(env.INKOS_STATE_VALIDATION_RETRIES) : undefined);
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_SETTLEMENT_RETRY_ATTEMPTS;
  return Math.min(MAX_SETTLEMENT_RETRY_ATTEMPTS, Math.max(1, Math.floor(raw)));
}

export type PreviousSettlement = Pick<WriteChapterOutput, "updatedHooks" | "updatedState" | "runtimeStateDelta">;

export interface SettlementRetryParams {
  readonly writer: Pick<WriterAgent, "settleChapterState">;
  readonly validator: Pick<StateValidatorAgent, "validate">;
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly baselineChapter?: number;
  readonly allowNewHooks?: boolean;
  readonly title: string;
  readonly content: string;
  readonly reducedControlInput?: {
    chapterIntent: string;
    contextPackage: ContextPackage;
    ruleStack: RuleStack;
  };
  readonly oldState: string;
  readonly oldHooks: string;
  readonly originalValidation: ValidationResult;
  /** The settlement the validator just rejected; lets the retry rewrite it in place. */
  readonly previousOutput?: PreviousSettlement;
  /** Override for resolveSettlementRetryAttempts(). */
  readonly maxAttempts?: number;
  readonly language: LengthLanguage;
  readonly logWarn?: (message: { zh: string; en: string }) => void;
  readonly logger?: Pick<Logger, "warn">;
}

export type SettlementRetryResult =
  | {
    readonly kind: "recovered";
    readonly output: WriteChapterOutput;
    readonly validation: ValidationResult;
  }
  | {
    readonly kind: "degraded";
    readonly issues: ReadonlyArray<AuditIssue>;
  };

export async function retrySettlementAfterValidationFailure(
  params: SettlementRetryParams,
): Promise<SettlementRetryResult> {
  const maxAttempts = resolveSettlementRetryAttempts(params.maxAttempts);
  let lastValidation = params.originalValidation;
  let lastOutput: PreviousSettlement | undefined = params.previousOutput;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    params.logWarn?.(maxAttempts > 1
      ? {
          zh: `状态校验失败，正在仅重试结算层（第${params.chapterNumber}章，第 ${attempt}/${maxAttempts} 次）`,
          en: `State validation failed; retrying settlement only for chapter ${params.chapterNumber} (attempt ${attempt}/${maxAttempts})`,
        }
      : {
          zh: `状态校验失败，正在仅重试结算层（第${params.chapterNumber}章）`,
          en: `State validation failed; retrying settlement only for chapter ${params.chapterNumber}`,
        });

    const retryOutput = await params.writer.settleChapterState({
      book: params.book,
      bookDir: params.bookDir,
      chapterNumber: params.chapterNumber,
      title: params.title,
      content: params.content,
      allowReapply: true,
      baselineChapter: params.baselineChapter,
      allowNewHooks: params.allowNewHooks,
      chapterIntent: params.reducedControlInput?.chapterIntent,
      contextPackage: params.reducedControlInput?.contextPackage,
      ruleStack: params.reducedControlInput?.ruleStack,
      validationFeedback: buildTargetedSettlementFeedback({
        warnings: lastValidation.warnings,
        language: params.language,
        previousOutput: lastOutput,
        oldHooks: params.oldHooks,
      }),
    });

    let retryValidation: ValidationResult;
    try {
      retryValidation = await params.validator.validate(
        params.content,
        params.chapterNumber,
        params.oldState,
        retryOutput.updatedState,
        params.oldHooks,
        retryOutput.updatedHooks,
        params.language,
      );
    } catch (error) {
      throw new Error(`State validation retry failed for chapter ${params.chapterNumber}: ${String(error)}`);
    }

    if (retryValidation.warnings.length > 0) {
      params.logWarn?.({
        zh: `状态校验重试后，第${params.chapterNumber}章仍有 ${retryValidation.warnings.length} 条警告`,
        en: `State validation retry still reports ${retryValidation.warnings.length} warning(s) for chapter ${params.chapterNumber}`,
      });
      for (const warning of retryValidation.warnings) {
        params.logger?.warn(`  [${warning.category}] ${warning.description}`);
      }
    }

    if (retryValidation.passed && !retryValidation.repairRequired) {
      return {
        kind: "recovered",
        output: retryOutput,
        validation: retryValidation,
      };
    }

    lastValidation = retryValidation;
    lastOutput = retryOutput;
  }

  return {
    kind: "degraded",
    issues: buildStateDegradedIssues(lastValidation.warnings, params.language),
  };
}

/**
 * Hook ids the validator named in its warnings, restricted to ids that exist
 * in the given ledgers (so "H02" does not match inside "H023").
 */
export function extractFlaggedHookIds(
  warnings: ReadonlyArray<ValidationWarning>,
  knownHookIds: ReadonlyArray<string>,
): string[] {
  const text = warnings.map((warning) => warning.description).join("\n");
  const flagged = knownHookIds.filter((hookId) => {
    const escaped = hookId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(text);
  });
  return [...new Set(flagged)];
}

/**
 * Validation feedback for a settlement retry. Besides the validator warnings
 * it pins the hooks the validator named (with their rows from the rejected
 * settlement) and hands back the rejected RUNTIME_STATE_DELTA so the model
 * edits it in place instead of regenerating everything from scratch.
 */
export function buildTargetedSettlementFeedback(params: {
  readonly warnings: ReadonlyArray<ValidationWarning>;
  readonly language: LengthLanguage;
  readonly previousOutput?: PreviousSettlement;
  readonly oldHooks?: string;
}): string {
  const base = buildStateValidationFeedback(params.warnings, params.language);
  const previousHooks = params.previousOutput?.updatedHooks ?? "";
  const ledgers = [previousHooks, params.oldHooks ?? ""].filter((ledger) => ledger.trim());
  const knownIds = [...new Set(ledgers.flatMap((ledger) => parsePendingHooksMarkdown(ledger).map((hook) => hook.hookId)))];
  const flagged = extractFlaggedHookIds(params.warnings, knownIds);

  const rows = flagged
    .map((hookId) => findLedgerRow(previousHooks, hookId) ?? findLedgerRow(params.oldHooks ?? "", hookId))
    .filter((row): row is string => Boolean(row));
  const header = findLedgerHeader(previousHooks) ?? findLedgerHeader(params.oldHooks ?? "");

  const delta = params.previousOutput?.runtimeStateDelta;
  const deltaJson = delta ? JSON.stringify(delta, null, 2) : "";
  const includeDelta = deltaJson.length > 0 && deltaJson.length <= MAX_PREVIOUS_DELTA_CHARS;

  if (flagged.length === 0 && !includeDelta) return base;

  const en = params.language === "en";
  const parts = [base, ""];
  parts.push(en ? "## Targeted correction scope" : "## 定向修正范围");
  if (flagged.length > 0) {
    parts.push(en
      ? `Hooks named by the validator: ${flagged.join(", ")}. Re-check each of them against the chapter text and fix status / lastAdvancedChapter / notes (write them into hookOps.upsert, and resolve / defer where applicable).`
      : `校验点名的伏笔：${flagged.join("、")}。逐条对照正文核对并修正 status / lastAdvancedChapter / notes，写进 hookOps.upsert（回收或延后的同时放进 resolve / defer）。`);
    if (header && rows.length > 0) {
      parts.push(en ? "Their rows after the rejected settlement:" : "它们在被驳回的那次结算后的记录：", header, ...rows);
    }
  }
  if (includeDelta) {
    parts.push(
      en
        ? "The rejected RUNTIME_STATE_DELTA is below. Use it as the draft: keep every entry the validator did not object to exactly as it is, change only what the warnings above point at, and output the complete corrected delta."
        : "下面是被驳回的 RUNTIME_STATE_DELTA。以它为底稿：校验没有指出问题的条目原样保留，只修改上面警告指出的伏笔和状态卡字段，然后输出完整的修正后 delta。",
      "```json",
      deltaJson,
      "```",
    );
  } else if (flagged.length > 0) {
    parts.push(en
      ? "Hooks not named above must keep their current state; do not drop them."
      : "未被点名的伏笔保持现有状态，不要删除。");
  }
  return parts.join("\n");
}

function ledgerTableLines(markdown: string): string[] {
  return markdown.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("|"));
}

function findLedgerHeader(markdown: string): string | undefined {
  const lines = ledgerTableLines(markdown);
  const separatorIndex = lines.findIndex((line) => /^\|\s*-{3,}/.test(line));
  if (separatorIndex <= 0) return undefined;
  return `${lines[separatorIndex - 1]}\n${lines[separatorIndex]}`;
}

function findLedgerRow(markdown: string, hookId: string): string | undefined {
  return ledgerTableLines(markdown).find((line) => {
    const firstCell = line.split("|")[1]?.trim();
    return firstCell === hookId;
  });
}

export function buildStateValidationFeedback(
  warnings: ReadonlyArray<ValidationWarning>,
  language: LengthLanguage,
): string {
  if (warnings.length === 0) {
    return language === "en"
      ? "The previous settlement contradicted the chapter text. Reconcile truth files strictly to the body."
      : "上一次状态结算与正文矛盾。请严格以正文为准修正 truth files。";
  }

  if (language === "en") {
    return [
      "The previous settlement failed validation. Fix these contradictions against the chapter body:",
      ...warnings.map((warning) => `- [${warning.category}] ${warning.description}`),
    ].join("\n");
  }

  return [
    "上一次状态结算未通过校验。请对照正文修正以下矛盾：",
    ...warnings.map((warning) => `- [${warning.category}] ${warning.description}`),
  ].join("\n");
}

export function buildStateDegradedIssues(
  warnings: ReadonlyArray<ValidationWarning>,
  language: LengthLanguage,
): ReadonlyArray<AuditIssue> {
  if (warnings.length > 0) {
    return warnings.map((warning) => ({
      severity: "warning" as const,
      category: "state-validation",
      description: warning.description,
      suggestion: language === "en"
        ? "Repair chapter state from the persisted body before continuing."
        : "请先基于已保存正文修复本章 state，再继续后续章节。",
    }));
  }

  return [{
    severity: "warning",
    category: "state-validation",
    description: language === "en"
      ? "State validation still failed after settlement retry."
      : "状态结算重试后仍未通过校验。",
    suggestion: language === "en"
      ? "Repair chapter state from the persisted body before continuing."
      : "请先基于已保存正文修复本章 state，再继续后续章节。",
  }];
}

export function buildStateDegradedPersistenceOutput(params: {
  readonly output: WriteChapterOutput;
  readonly oldState: string;
  readonly oldHooks: string;
  readonly oldLedger: string;
}): WriteChapterOutput {
  return {
    ...params.output,
    runtimeStateDelta: undefined,
    runtimeStateSnapshot: undefined,
    updatedState: params.oldState,
    updatedLedger: params.oldLedger,
    updatedHooks: params.oldHooks,
    updatedChapterSummaries: undefined,
  };
}

export interface StateDegradedReviewNote {
  readonly kind: "state-degraded";
  readonly baseStatus: "ready-for-review" | "audit-failed";
  readonly injectedIssues: ReadonlyArray<string>;
}

export function buildStateDegradedReviewNote(
  baseStatus: "ready-for-review" | "audit-failed",
  issues: ReadonlyArray<AuditIssue>,
): string {
  return JSON.stringify({
    kind: "state-degraded",
    baseStatus,
    injectedIssues: issues.map((issue) => `[${issue.severity}] ${issue.description}`),
  } satisfies StateDegradedReviewNote);
}

export function parseStateDegradedReviewNote(
  reviewNote?: string,
): StateDegradedReviewNote | null {
  if (!reviewNote) {
    return null;
  }

  try {
    const parsed = JSON.parse(reviewNote) as {
      kind?: unknown;
      baseStatus?: unknown;
      injectedIssues?: unknown;
    };
    if (
      parsed.kind !== "state-degraded"
      || (parsed.baseStatus !== "ready-for-review" && parsed.baseStatus !== "audit-failed")
      || !Array.isArray(parsed.injectedIssues)
    ) {
      return null;
    }

    return {
      kind: "state-degraded",
      baseStatus: parsed.baseStatus,
      injectedIssues: parsed.injectedIssues.filter((issue): issue is string => typeof issue === "string"),
    };
  } catch {
    return null;
  }
}

export function resolveStateDegradedBaseStatus(
  chapter: Pick<ChapterMeta, "reviewNote" | "auditIssues">,
): "ready-for-review" | "audit-failed" {
  const metadata = parseStateDegradedReviewNote(chapter.reviewNote);
  if (metadata) {
    return metadata.baseStatus;
  }

  return chapter.auditIssues.some((issue) => issue.startsWith("[critical]"))
    ? "audit-failed"
    : "ready-for-review";
}
