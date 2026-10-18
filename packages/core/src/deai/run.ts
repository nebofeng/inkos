/**
 * Unified de-AI pipeline: load → score → gate → rewrite → rescore → settle.
 * Post-write, shorts (S7), CLI, and Studio all call `runDeAI`.
 */

import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractGlossaryFromBookDir, rewriteFlaggedParagraphs } from "../ai-flavor/index.js";
import { preDeslopSidecarName, readChapterMarkdown, replaceChapterBody } from "../pipeline/chapter-files.js";
import { createDeslopReviser, createLocalRewriteLlm } from "../pipeline/deslop-runner.js";
import { evaluateQualityGate, type QualityGateEvaluation } from "../quality-gate/evaluate.js";
import { appendQualityGateRecord, type QualityGateChapterRecord } from "../quality-gate/persist.js";
import { ANTI_DETECT_SKILL, FULL_DEAI_SKILL, resolveDeAIConfig, type EffectiveDeAIConfig } from "./config.js";
import { DeAIPauseError } from "./errors.js";
import { appendDeAIRecord } from "./persist.js";
import {
  resolveDeAISkill,
  rewritePromptsForDeAISkill,
  scanDeAISkillBans,
  type DeAISkill,
} from "./skills.js";
import type {
  DeAIChapterRecord,
  DeAIInput,
  DeAIResult,
  DeAIRewriter,
  DeAIStatus,
} from "./types.js";

const SKIP_AUDIT = "audit-failed";
const SKIP_DEGRADED = "state-degraded";

export async function runDeAI(input: DeAIInput): Promise<DeAIResult> {
  const resolved = resolveDeAIConfig({
    project: input.project,
    book: input.book,
    preset: input.preset,
    overrides: input.overrides,
    emitDeprecation: false,
  });
  const resolvedConfig = resolved.config;
  const skillResolution = await resolveDeAISkill(resolvedConfig.skill, {
    projectRoot: input.projectRoot ?? inferProjectRoot(input.bookDir, input.bookId) ?? input.bookDir,
    bookId: input.bookId,
    homeDir: input.homeDir,
  });
  for (const warning of skillResolution.warnings) {
    input.logger?.warn(warning);
  }
  const skill = skillResolution.skill;
  const config: EffectiveDeAIConfig = skill.id === resolvedConfig.skill
    ? resolvedConfig
    : { ...resolvedConfig, skill: skill.id };
  const minWords = input.minWords ?? 0;
  const evaluatedAt = input.now?.() ?? new Date().toISOString();
  const mode = input.mode ?? "full";
  const persist = input.persist !== false;
  const persistDeAI = input.persistDeAI !== false && persist;
  const skipReasonHint = input.skipReason;
  const scoreOnly = mode === "score-only"
    || skipReasonHint === SKIP_AUDIT
    || skipReasonHint === SKIP_DEGRADED;

  throwIfAborted(input.signal);

  const loaded = await loadStage(input);
  const originalContent = loaded.content;
  let content = loaded.content;
  const previousText = loaded.previousText;
  const glossary = input.glossary ?? await loadGlossary(input.bookDir);

  throwIfAborted(input.signal);

  if (!config.rewriteEnabled && !config.gateEnabled) {
    return settle({
      input,
      config,
      originalContent,
      content,
      previousText,
      minWords,
      attempts: 0,
      rewritten: false,
      persist,
      persistDeAI,
      evaluatedAt,
      status: "skipped",
      skipReason: "deAI.enabled=false",
      allowPause: false,
    });
  }

  if (scoreOnly) {
    const skipReason = skipReasonHint
      ?? (mode === "score-only" ? "score-only" : undefined)
      ?? "score-only";
    await maybeExternalDetect(input, config, content);
    return settle({
      input,
      config,
      originalContent,
      content,
      previousText,
      minWords,
      attempts: 0,
      rewritten: false,
      persist,
      persistDeAI,
      evaluatedAt,
      status: "skipped",
      skipReason,
      allowPause: false,
    });
  }

  throwIfAborted(input.signal);
  let evaluation = score(content, previousText, minWords, config);
  let attempts = 0;
  let rewritten = false;

  const rewriteRounds = rewriteRoundCap(config, evaluation.passed);
  const rewriter = input.rewriter ?? defaultRewriter(input, skill);

  while (!evaluation.passed && attempts < rewriteRounds) {
    throwIfAborted(input.signal);
    attempts += 1;
    const next = await rewriteWithCallRetries({
      rewriter,
      config,
      text: content,
      previousText,
      glossary,
      targetWordCount: minWords || null,
      attempt: attempts,
      signal: input.signal,
      bookDir: input.bookDir,
      chapterNumber: input.chapterNumber,
      logger: input.logger,
    });
    if (!next || next === content) break;
    content = next;
    rewritten = true;
    evaluation = score(content, previousText, minWords, config);
  }

  await maybeExternalDetect(input, config, content);

  if (rewritten) {
    evaluation = withBanIssues(evaluation, scanDeAISkillBans(content, skill));
  }

  const status: DeAIStatus = evaluation.passed ? "ok" : "warned";
  return settle({
    input,
    config,
    originalContent,
    content,
    previousText,
    minWords,
    attempts,
    rewritten,
    persist,
    persistDeAI,
    evaluatedAt,
    status: config.gateEnabled ? status : (rewritten ? "ok" : "skipped"),
    skipReason: config.gateEnabled ? undefined : "deAI.gateEnabled=false",
    allowPause: config.gateEnabled && config.onFail === "pause",
    evaluation,
  });
}

function rewriteRoundCap(config: EffectiveDeAIConfig, alreadyPassed: boolean): number {
  if (!config.rewriteEnabled) return 0;
  if (config.gateEnabled && alreadyPassed) return 0;
  if (!config.gateEnabled) return 1;
  if (config.onFail === "retry") return Math.max(0, config.maxRetries);
  return 1;
}

function score(
  text: string,
  previousText: string,
  minWords: number,
  config: EffectiveDeAIConfig,
): QualityGateEvaluation {
  return evaluateQualityGate({
    text,
    previousText,
    minWords,
    aiFlavorThreshold: config.aiFlavorThreshold,
    minWordRatio: config.minWordRatio,
  });
}

async function loadStage(input: DeAIInput): Promise<{ content: string; previousText: string }> {
  let content = input.text;
  if (content === undefined) {
    content = (await readChapterMarkdown(input.bookDir, input.chapterNumber)).body;
  }
  let previousText = input.previousText;
  if (previousText === undefined) {
    previousText = await readPreviousChapterBody(input.bookDir, input.chapterNumber);
  }
  return { content, previousText };
}

async function loadGlossary(bookDir: string): Promise<readonly string[]> {
  try {
    return await extractGlossaryFromBookDir(bookDir);
  } catch {
    return [];
  }
}

async function readPreviousChapterBody(bookDir: string, chapterNumber: number): Promise<string> {
  if (chapterNumber <= 1) return "";
  try {
    return (await readChapterMarkdown(bookDir, chapterNumber - 1)).body;
  } catch {
    return "";
  }
}

function defaultRewriter(input: DeAIInput, skill: DeAISkill): DeAIRewriter {
  return async (rewriteInput) => {
    const ctx = input.rewriteCtx;
    if ((rewriteInput.skill === FULL_DEAI_SKILL || rewriteInput.skill === ANTI_DETECT_SKILL) && ctx) {
      const reviser = await createDeslopReviser(ctx);
      const anti = rewriteInput.skill === ANTI_DETECT_SKILL;
      const output = await reviser.reviseChapter(
        rewriteInput.bookDir,
        rewriteInput.text,
        rewriteInput.chapterNumber,
        [{
          severity: "warning",
          category: anti ? "AIGC检测" : "style",
          description: anti
            ? "降低AI生成可检测性：段落长度差异、套话、公式化转折、列表式结构"
            : "Remove AI-sounding prose",
          suggestion: anti
            ? "增加段落长度差异、减少套话、用口语化表达替代书面语"
            : "Rewrite with a more natural voice",
        }],
        anti ? "anti-detect" : "polish",
        input.genre,
      );
      const revised = output.revisedContent.trim();
      return revised || rewriteInput.text;
    }
    if (!ctx) return rewriteInput.text;
    const llm = createLocalRewriteLlm(ctx);
    const result = await rewriteFlaggedParagraphs({
      text: rewriteInput.text,
      previousText: rewriteInput.previousText,
      targetWordCount: rewriteInput.targetWordCount,
      glossary: rewriteInput.glossary,
      prompts: rewritePromptsForDeAISkill(skill),
      llm,
    });
    return result.merged;
  };
}

function withBanIssues(
  evaluation: QualityGateEvaluation,
  issues: readonly string[],
): QualityGateEvaluation {
  if (issues.length === 0) return evaluation;
  return { ...evaluation, reasons: [...evaluation.reasons, ...issues] };
}

function inferProjectRoot(bookDir: string, bookId: string): string | undefined {
  const normalized = bookDir.replace(/\\/g, "/");
  const suffix = `/books/${bookId}`;
  if (normalized.endsWith(suffix)) {
    return bookDir.slice(0, bookDir.length - suffix.length);
  }
  return undefined;
}

async function rewriteWithCallRetries(args: {
  rewriter: DeAIRewriter;
  config: EffectiveDeAIConfig;
  text: string;
  previousText: string;
  glossary: readonly string[];
  targetWordCount: number | null;
  attempt: number;
  signal?: AbortSignal;
  bookDir: string;
  chapterNumber: number;
  logger?: DeAIInput["logger"];
}): Promise<string | undefined> {
  const callRetries = Math.max(1, args.config.rewriteCallRetries);
  let lastError: string | undefined;
  for (let call = 1; call <= callRetries; call++) {
    throwIfAborted(args.signal);
    try {
      return await args.rewriter({
        text: args.text,
        previousText: args.previousText,
        skill: args.config.skill,
        glossary: args.glossary,
        targetWordCount: args.targetWordCount,
        attempt: args.attempt,
        signal: args.signal,
        bookDir: args.bookDir,
        chapterNumber: args.chapterNumber,
      });
    } catch (error) {
      if (args.signal?.aborted) throw error;
      lastError = error instanceof Error ? error.message : String(error);
      args.logger?.warn(
        `deAI rewrite call failed (content ${args.attempt}, call ${call}/${callRetries}): ${lastError}`,
      );
    }
  }
  args.logger?.warn(`deAI rewrite gave up after ${callRetries} call(s): ${lastError ?? "unknown"}`);
  return undefined;
}

async function maybeExternalDetect(
  input: DeAIInput,
  config: EffectiveDeAIConfig,
  text: string,
): Promise<void> {
  if (!config.externalDetect.enabled) return;
  if (!input.runExternalDetect) {
    input.logger?.debug("deAI.externalDetect enabled but no runner; skipping");
    return;
  }
  throwIfAborted(input.signal);
  await input.runExternalDetect({ text, config: config.externalDetect });
}

async function settle(args: {
  input: DeAIInput;
  config: EffectiveDeAIConfig;
  originalContent: string;
  content: string;
  previousText: string;
  minWords: number;
  attempts: number;
  rewritten: boolean;
  persist: boolean;
  persistDeAI: boolean;
  evaluatedAt: string;
  status: DeAIStatus;
  skipReason?: string;
  allowPause: boolean;
  evaluation?: QualityGateEvaluation;
}): Promise<DeAIResult> {
  const evaluation = args.evaluation ?? score(
    args.content,
    args.previousText,
    args.minWords,
    args.config,
  );
  const skipped = args.status === "skipped";
  let originalPath: string | undefined;
  let jsonPath: string | undefined;
  let deaiJsonPath: string | undefined;

  if (args.persist && args.rewritten && args.content !== args.originalContent) {
    originalPath = await writeRewrittenBody(args.input, args.originalContent, args.content, args.config.keepOriginal);
  }

  const record = buildQualityGateRecord({
    chapterNumber: args.input.chapterNumber,
    minWords: args.minWords,
    config: args.config,
    evaluation,
    attempts: args.attempts,
    skipped,
    evaluatedAt: args.evaluatedAt,
  });
  const deaiRecord = buildDeAIRecord({
    chapterNumber: args.input.chapterNumber,
    status: args.status,
    skipReason: args.skipReason,
    passed: evaluation.passed,
    evaluation,
    attempts: args.attempts,
    rewritten: args.rewritten,
    skill: args.config.skill,
    originalPath,
    evaluatedAt: args.evaluatedAt,
  });

  if (args.persist) {
    jsonPath = await appendQualityGateRecord(args.input.bookDir, args.input.bookId, record);
  }
  if (args.persistDeAI) {
    deaiJsonPath = await appendDeAIRecord(args.input.bookDir, args.input.bookId, deaiRecord);
  }

  if (!evaluation.passed && args.config.gateEnabled && !skipped) {
    const detail = evaluation.reasons.join("; ") || "failed";
    args.input.logger?.warn(
      `deAI failed for ${args.input.bookId} ch.${args.input.chapterNumber}: ${detail}`,
    );
    if (args.allowPause) {
      throw new DeAIPauseError(args.input.chapterNumber, evaluation.reasons);
    }
  }

  return {
    status: args.status,
    skipped,
    skipReason: args.skipReason,
    passed: skipped ? true : evaluation.passed,
    rewritten: args.rewritten,
    content: args.content,
    originalContent: args.originalContent,
    score: evaluation.score,
    wordCount: evaluation.wordCount,
    reasons: evaluation.reasons,
    attempts: args.attempts,
    evaluation,
    record,
    deaiRecord,
    config: args.config,
    jsonPath,
    deaiJsonPath,
    originalPath,
  };
}

function buildQualityGateRecord(args: {
  chapterNumber: number;
  minWords: number;
  config: EffectiveDeAIConfig;
  evaluation: QualityGateEvaluation;
  attempts: number;
  skipped: boolean;
  evaluatedAt: string;
}): QualityGateChapterRecord {
  return {
    chapterNumber: args.chapterNumber,
    passed: args.evaluation.passed,
    score: args.evaluation.score,
    wordCount: args.evaluation.wordCount,
    minWords: args.minWords,
    aiFlavorThreshold: args.config.aiFlavorThreshold,
    reasons: args.evaluation.reasons,
    onFail: args.config.onFail,
    attempts: args.attempts,
    ...(args.skipped ? { skipped: true } : {}),
    evaluatedAt: args.evaluatedAt,
  };
}

function buildDeAIRecord(args: {
  chapterNumber: number;
  status: DeAIStatus;
  skipReason?: string;
  passed: boolean;
  evaluation: QualityGateEvaluation;
  attempts: number;
  rewritten: boolean;
  skill: string;
  originalPath?: string;
  evaluatedAt: string;
}): DeAIChapterRecord {
  return {
    chapterNumber: args.chapterNumber,
    status: args.status,
    ...(args.skipReason ? { skipReason: args.skipReason } : {}),
    passed: args.passed,
    score: args.evaluation.score,
    wordCount: args.evaluation.wordCount,
    attempts: args.attempts,
    rewritten: args.rewritten,
    skill: args.skill,
    reasons: args.evaluation.reasons,
    ...(args.originalPath ? { originalPath: args.originalPath } : {}),
    evaluatedAt: args.evaluatedAt,
  };
}

async function writeRewrittenBody(
  input: DeAIInput,
  _original: string,
  body: string,
  keepOriginal: boolean,
): Promise<string | undefined> {
  const chapter = await readChapterMarkdown(input.bookDir, input.chapterNumber);
  if (chapter.body === body) return undefined;
  let originalPath: string | undefined;
  if (keepOriginal) {
    const sidecarName = preDeslopSidecarName(chapter.fileName);
    await copyFile(chapter.filePath, join(input.bookDir, "chapters", sidecarName));
    originalPath = join("chapters", sidecarName);
  }
  await writeFile(chapter.filePath, replaceChapterBody(chapter.raw, body), "utf-8");
  return originalPath;
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
