/**
 * Shared write-success hook: runDeAI (deslop + quality-gate) → detect → publish eligibility.
 * Used by PipelineRunner (daemon, CLI write, Studio write) after ready-for-review.
 *
 * S0: onFail / enabled / maxRetries come from resolveDeAIConfig (via runDeAI /
 * resolveQualityGateConfig) — never re-merge project vs book here.
 */

import { writeFile } from "node:fs/promises";
import type { AgentContext } from "../agents/base.js";
import type { ChapterMeta } from "../models/chapter.js";
import type { BookDeAIOverride, DetectionConfig, DeslopConfig, ProjectDeAIConfig, QualityGateConfig } from "../models/project.js";
import { DEFAULT_DESLOP_CONFIG } from "../models/project.js";
import type { Logger } from "../utils/logger.js";
import { countChapterLength } from "../utils/length-metrics.js";
import { createDeslopReviser, createLocalRewriteLlm, runDeslop, type DeslopResult, type DeslopReviser } from "./deslop-runner.js";
import { computePublishEligible, resolveBookOpeningHardGate } from "./publish-eligibility.js";
import type { OpeningCheckOverride } from "../opening-check/hard-gate.js";
import { readChapterMarkdown, replaceChapterBody } from "./chapter-files.js";
import type { DetectAndRewriteResult, DetectChapterResult } from "./detection-runner.js";
import {
  extractGlossaryFromBookDir,
  rewriteFlaggedParagraphs,
} from "../ai-flavor/index.js";
import { isQualityGatePauseError, resolveQualityGateConfig, runQualityGate } from "../quality-gate/index.js";
import { isDeAIPauseError, runDeAI, type DeAIResult } from "../deai/index.js";

type DetectChapterFn = (
  config: DetectionConfig,
  content: string,
  chapterNumber: number,
) => Promise<DetectChapterResult>;
type DetectAndRewriteFn = (
  config: DetectionConfig,
  ctx: AgentContext,
  bookDir: string,
  content: string,
  chapterNumber: number,
  genre?: string,
) => Promise<DetectAndRewriteResult>;

export interface PostWriteCleanupInput {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly bookDir: string;
  readonly genre?: string;
  readonly deslop?: DeslopConfig;
  readonly detection?: DetectionConfig;
  readonly reviserCtx: AgentContext;
  readonly deaiRewriteCtx?: AgentContext;
  readonly loadChapterIndex: () => Promise<ReadonlyArray<ChapterMeta>>;
  readonly saveChapterIndex: (index: ReadonlyArray<ChapterMeta>) => Promise<void>;
  readonly logger?: Logger;
  readonly onError?: (bookId: string, error: Error) => void;
  readonly now?: () => string;
  readonly runDeslop?: typeof runDeslop;
  readonly detectChapter?: DetectChapterFn;
  readonly detectAndRewrite?: DetectAndRewriteFn;
  readonly createReviser?: (ctx: AgentContext) => Promise<DeslopReviser>;
  readonly qualityGate?: QualityGateConfig | null;
  readonly bookQualityGate?: Partial<QualityGateConfig> | null;
  readonly platformPresetId?: string | null;
  readonly minWords?: number;
  readonly runQualityGate?: typeof runQualityGate;
  readonly deAI?: ProjectDeAIConfig | null;
  readonly bookDeAI?: BookDeAIOverride | null;
  readonly runDeAI?: typeof runDeAI;
  readonly projectOpeningCheck?: OpeningCheckOverride;
  readonly bookOpeningCheck?: OpeningCheckOverride;
}

export interface PostWriteCleanupResult {
  readonly deslop: DeslopResult;
  readonly detectionPassed?: boolean;
  readonly detectionScore?: number;
  readonly publishEligible: boolean;
  readonly skippedDetect: boolean;
  readonly qualityGatePassed?: boolean;
  readonly qualityGateSkipped?: boolean;
}

export async function postWriteCleanup(input: PostWriteCleanupInput): Promise<PostWriteCleanupResult> {
  const now = input.now?.() ?? new Date().toISOString();

  let deslop: DeslopResult;
  let qualityGatePassed: boolean | undefined;
  let qualityGateSkipped: boolean | undefined;
  const useInjectedLegacy = input.runDeslop !== undefined || input.runQualityGate !== undefined;
  if (!useInjectedLegacy) {
    try {
      const deai = await runUnifiedDeAI(input);
      deslop = deslopFromDeAI(deai, input.chapterNumber);
      qualityGatePassed = deai.skipped ? undefined : deai.passed;
      qualityGateSkipped = deai.skipped;
    } catch (error) {
      if (isDeAIPauseError(error) || isQualityGatePauseError(error)) {
        await mergeChapterMeta(input, {
          deslopStatus: "ok",
          deslopAt: now,
          detectionPassed: undefined,
          publishEligible: false,
        }, now);
        throw error;
      }
      const err = error instanceof Error ? error : new Error(String(error));
      input.logger?.error(`deAI crashed for ${input.bookId} ch.${input.chapterNumber}: ${err.message}`);
      input.onError?.(input.bookId, err);
      deslop = {
        chapterNumber: input.chapterNumber,
        status: "failed",
        content: "",
        wordCount: 0,
        attempts: 0,
        error: err.message,
      };
    }
  } else {
  const deslopConfig = input.deslop ?? { ...DEFAULT_DESLOP_CONFIG, enabled: false };
  const runDeslopFn = input.runDeslop ?? runDeslop;

  try {
    const mode = deslopConfig.mode ?? "local";
    const reviser = deslopConfig.enabled && mode === "full"
      ? await (input.createReviser ?? createDeslopReviser)(input.reviserCtx)
      : { reviseChapter: async () => ({ revisedContent: "", wordCount: 0 }) };
    const localRewrite = deslopConfig.enabled && mode === "local"
      ? createLocalRewriteLlm(input.deaiRewriteCtx ?? input.reviserCtx)
      : undefined;
    deslop = await runDeslopFn({
      bookDir: input.bookDir,
      chapterNumber: input.chapterNumber,
      config: deslopConfig,
      reviser,
      localRewrite,
      logger: input.logger,
      genre: input.genre,
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    input.logger?.error(`deslop crashed for ${input.bookId} ch.${input.chapterNumber}: ${err.message}`);
    input.onError?.(input.bookId, err);
    deslop = {
      chapterNumber: input.chapterNumber,
      status: "failed",
      content: "",
      wordCount: 0,
      attempts: 0,
      error: err.message,
    };
  }

  if (deslop.status === "failed") {
    const publishEligible = false;
    await mergeChapterMeta(input, {
      deslopStatus: "failed",
      deslopAt: now,
      detectionPassed: undefined,
      publishEligible,
      wordCount: deslop.wordCount || undefined,
    }, now);
    if (deslop.error) {
      input.onError?.(input.bookId, new Error(`deslop failed: ${deslop.error}`));
    }
    return {
      deslop,
      publishEligible,
      skippedDetect: true,
    };
  }

  if (input.qualityGate !== undefined || input.bookQualityGate !== undefined) {
    try {
      const gate = await runPostWriteQualityGate(input, deslop.content);
      qualityGatePassed = gate.passed;
      qualityGateSkipped = gate.skipped;
    } catch (error) {
      if (isQualityGatePauseError(error)) {
        await mergeChapterMeta(input, {
          deslopStatus: deslop.status,
          deslopAt: now,
          detectionPassed: undefined,
          publishEligible: false,
          wordCount: deslop.status === "ok" ? deslop.wordCount : undefined,
        }, now);
        throw error;
      }
      const err = error instanceof Error ? error : new Error(String(error));
      input.logger?.error(`quality gate crashed for ${input.bookId} ch.${input.chapterNumber}: ${err.message}`);
      input.onError?.(input.bookId, err);
    }
  }

  } // injected legacy deslop + quality-gate

  if (deslop.status === "failed") {
    const publishEligible = false;
    await mergeChapterMeta(input, {
      deslopStatus: "failed",
      deslopAt: now,
      detectionPassed: undefined,
      publishEligible,
      wordCount: deslop.wordCount || undefined,
    }, now);
    if (deslop.error) {
      input.onError?.(input.bookId, new Error(`deslop failed: ${deslop.error}`));
    }
    return {
      deslop,
      publishEligible,
      skippedDetect: true,
      qualityGatePassed,
      qualityGateSkipped,
    };
  }

  if (!input.detection?.enabled) {
    const publishEligible = await computeCleanupPublishEligible(input, {
      deslopStatus: deslop.status,
      detectionPassed: undefined,
    });
    await mergeChapterMeta(input, {
      deslopStatus: deslop.status,
      deslopAt: now,
      detectionPassed: undefined,
      publishEligible,
      wordCount: deslop.status === "ok" ? deslop.wordCount : undefined,
    }, now);
    return {
      deslop,
      publishEligible,
      skippedDetect: true,
      qualityGatePassed,
      qualityGateSkipped,
    };
  }

  try {
    const detectionFns = (input.detectChapter && input.detectAndRewrite)
      ? { detectChapter: input.detectChapter, detectAndRewrite: input.detectAndRewrite }
      : await import("./detection-runner.js");
    const detectChapterFn = detectionFns.detectChapter;
    const detectAndRewriteFn = detectionFns.detectAndRewrite;
    const chapter = await readChapterMarkdown(input.bookDir, input.chapterNumber);
    let content = chapter.body;
    let det = await detectChapterFn(input.detection, content, input.chapterNumber);
    let attemptsContent = content;

    if (!det.passed && input.detection.autoRewrite) {
      const rewritten = await detectAndRewriteFn(
        input.detection,
        input.reviserCtx,
        input.bookDir,
        content,
        input.chapterNumber,
        input.genre,
      );
      attemptsContent = rewritten.finalContent;
      if (rewritten.finalContent && rewritten.finalContent !== content) {
        await writeFile(chapter.filePath, replaceChapterBody(chapter.raw, rewritten.finalContent), "utf-8");
      }
      det = {
        chapterNumber: input.chapterNumber,
        detection: {
          score: rewritten.finalScore,
          provider: det.detection.provider,
          detectedAt: now,
        },
        passed: rewritten.passed,
      };
      content = attemptsContent;
    }

    const publishEligible = await computeCleanupPublishEligible(input, {
      deslopStatus: deslop.status,
      detectionPassed: det.passed,
    });
    await mergeChapterMeta(input, {
      deslopStatus: deslop.status,
      deslopAt: now,
      detectionPassed: det.passed,
      detectionScore: det.detection.score,
      detectionProvider: det.detection.provider,
      detectedAt: det.detection.detectedAt,
      publishEligible,
      wordCount: countChapterLength(content, "zh_chars"),
    }, now);

    return {
      deslop,
      detectionPassed: det.passed,
      detectionScore: det.detection.score,
      publishEligible,
      skippedDetect: false,
      qualityGatePassed,
      qualityGateSkipped,
    };
  } catch (error) {
    if (isQualityGatePauseError(error)) throw error;
    const err = error instanceof Error ? error : new Error(String(error));
    input.logger?.error(`detection failed for ${input.bookId} ch.${input.chapterNumber}: ${err.message}`);
    input.onError?.(input.bookId, err);
    const publishEligible = false;
    await mergeChapterMeta(input, {
      deslopStatus: deslop.status,
      deslopAt: now,
      detectionPassed: false,
      publishEligible,
      wordCount: deslop.status === "ok" ? deslop.wordCount : undefined,
    }, now);
    return {
      deslop,
      detectionPassed: false,
      publishEligible,
      skippedDetect: false,
      qualityGatePassed,
      qualityGateSkipped,
    };
  }
}

async function runPostWriteQualityGate(
  input: PostWriteCleanupInput,
  deslopContent: string,
): Promise<{ passed: boolean; skipped: boolean }> {
  const run = input.runQualityGate ?? runQualityGate;
  const minWords = input.minWords ?? 0;
  const resolved = resolveQualityGateConfig(
    input.qualityGate,
    input.bookQualityGate,
    input.platformPresetId,
  );
  const rewrite = resolved.onFail === "retry"
    ? async (text: string, previousText: string) => {
        const glossary = await extractGlossaryFromBookDir(input.bookDir);
        const llm = createLocalRewriteLlm(input.deaiRewriteCtx ?? input.reviserCtx);
        const result = await rewriteFlaggedParagraphs({
          text,
          previousText,
          targetWordCount: minWords || null,
          glossary,
          llm,
        });
        return result.merged;
      }
    : undefined;
  const result = await run({
    bookId: input.bookId,
    bookDir: input.bookDir,
    chapterNumber: input.chapterNumber,
    minWords,
    config: input.qualityGate,
    bookConfig: input.bookQualityGate,
    platformPresetId: input.platformPresetId,
    text: deslopContent || undefined,
    logger: input.logger,
    rewrite,
  });
  return { passed: result.passed, skipped: result.skipped };
}

async function runUnifiedDeAI(input: PostWriteCleanupInput): Promise<DeAIResult> {
  const run = input.runDeAI ?? runDeAI;
  return run({
    bookId: input.bookId,
    bookDir: input.bookDir,
    chapterNumber: input.chapterNumber,
    minWords: input.minWords ?? 0,
    project: {
      deAI: input.deAI,
      deslop: input.deslop,
      qualityGate: input.qualityGate,
      detection: input.detection,
    },
    book: {
      deAI: input.bookDeAI,
      qualityGate: input.bookQualityGate,
    },
    preset: input.platformPresetId,
    logger: input.logger,
    now: input.now,
    rewriteCtx: input.deaiRewriteCtx ?? input.reviserCtx,
    genre: input.genre,
  });
}

function deslopFromDeAI(result: DeAIResult, chapterNumber: number): DeslopResult {
  if (result.status === "failed") {
    return {
      chapterNumber,
      status: "failed",
      content: result.content,
      wordCount: result.wordCount,
      attempts: result.attempts,
      error: result.reasons.join("; ") || "deAI failed",
    };
  }
  if (result.skipped && !result.rewritten) {
    return {
      chapterNumber,
      status: "skipped",
      content: result.content,
      wordCount: result.wordCount,
      attempts: 0,
      originalPath: result.originalPath,
    };
  }
  return {
    chapterNumber,
    status: "ok",
    content: result.content,
    wordCount: result.wordCount,
    attempts: result.attempts,
    originalPath: result.originalPath,
  };
}

async function mergeChapterMeta(
  input: PostWriteCleanupInput,
  patch: Partial<ChapterMeta>,
  now: string,
): Promise<void> {
  const index = await input.loadChapterIndex();
  const updated = index.map((chapter) => {
    if (chapter.number !== input.chapterNumber) return chapter;
    return {
      ...chapter,
      ...patch,
      updatedAt: now,
    };
  });
  await input.saveChapterIndex(updated);
}

async function computeCleanupPublishEligible(
  input: PostWriteCleanupInput,
  eligibility: {
    readonly deslopStatus?: ChapterMeta["deslopStatus"];
    readonly detectionPassed?: boolean;
  },
): Promise<boolean> {
  const openingHardGatePassed = input.chapterNumber <= 3
    ? (await resolveBookOpeningHardGate({
      bookDir: input.bookDir,
      projectOpeningCheck: input.projectOpeningCheck,
      bookOpeningCheck: input.bookOpeningCheck,
    })).passed
    : true;
  return computePublishEligible({
    ...eligibility,
    openingHardGatePassed,
  });
}
