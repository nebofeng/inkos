/**
 * Shared write-success hook: deslop → quality-gate → detect → publish eligibility.
 * Used by PipelineRunner (daemon, CLI write, Studio write) after ready-for-review.
 */

import { writeFile } from "node:fs/promises";
import type { AgentContext } from "../agents/base.js";
import type { ChapterMeta } from "../models/chapter.js";
import type { DetectionConfig, DeslopConfig, QualityGateConfig } from "../models/project.js";
import { DEFAULT_DESLOP_CONFIG } from "../models/project.js";
import type { Logger } from "../utils/logger.js";
import { countChapterLength } from "../utils/length-metrics.js";
import { createDeslopReviser, createLocalRewriteLlm, runDeslop, type DeslopResult, type DeslopReviser } from "./deslop-runner.js";
import { computePublishEligible } from "./publish-eligibility.js";
import { readChapterMarkdown, replaceChapterBody } from "./chapter-files.js";
import type { DetectAndRewriteResult, DetectChapterResult } from "./detection-runner.js";
import {
  extractGlossaryFromBookDir,
  rewriteFlaggedParagraphs,
} from "../ai-flavor/index.js";
import { isQualityGatePauseError, runQualityGate } from "../quality-gate/index.js";

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
  const deslopConfig = input.deslop ?? { ...DEFAULT_DESLOP_CONFIG, enabled: false };
  const runDeslopFn = input.runDeslop ?? runDeslop;

  let deslop: DeslopResult;
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

  let qualityGatePassed: boolean | undefined;
  let qualityGateSkipped: boolean | undefined;
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

  if (!input.detection?.enabled) {
    const publishEligible = computePublishEligible({
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

    const publishEligible = computePublishEligible({
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
  const onFail = input.qualityGate?.onFail ?? input.bookQualityGate?.onFail ?? "warn";
  const rewrite = onFail === "retry"
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
