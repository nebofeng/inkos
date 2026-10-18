import { writeFile } from "node:fs/promises";
import type { QualityGateConfig } from "../models/project.js";
import { readChapterMarkdown, replaceChapterBody } from "../pipeline/chapter-files.js";
import type { Logger } from "../utils/logger.js";
import { resolveQualityGateConfig } from "./config.js";
import { evaluateQualityGate, type QualityGateEvaluation } from "./evaluate.js";
import { QualityGatePauseError } from "./errors.js";
import { appendQualityGateRecord, type QualityGateChapterRecord } from "./persist.js";

export interface RunQualityGateInput {
  readonly bookId: string;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly minWords: number;
  readonly config?: Partial<QualityGateConfig> | null;
  readonly bookConfig?: Partial<QualityGateConfig> | null;
  readonly platformPresetId?: string | null;
  readonly text?: string;
  readonly previousText?: string;
  readonly persist?: boolean;
  readonly logger?: Logger;
  readonly now?: () => string;
  readonly rewrite?: (text: string, previousText: string) => Promise<string>;
}

export interface QualityGateRunResult {
  readonly skipped: boolean;
  readonly skipReason?: string;
  readonly passed: boolean;
  readonly evaluation: QualityGateEvaluation;
  readonly attempts: number;
  readonly rewritten: boolean;
  readonly content: string;
  readonly record: QualityGateChapterRecord;
  readonly jsonPath?: string;
}

export async function runQualityGate(input: RunQualityGateInput): Promise<QualityGateRunResult> {
  const config = resolveQualityGateConfig(input.config, input.bookConfig, input.platformPresetId);
  const evaluatedAt = input.now?.() ?? new Date().toISOString();
  const previousText = input.previousText ?? await readPreviousChapterBody(input.bookDir, input.chapterNumber);
  let content = input.text ?? (await readChapterMarkdown(input.bookDir, input.chapterNumber)).body;

  if (!config.enabled) {
    const evaluation: QualityGateEvaluation = { passed: true, score: 0, wordCount: 0, reasons: [] };
    const record = buildRecord(input, config, evaluation, 0, evaluatedAt, true);
    const jsonPath = input.persist === false
      ? undefined
      : await appendQualityGateRecord(input.bookDir, input.bookId, record);
    return {
      skipped: true,
      skipReason: "qualityGate.enabled=false",
      passed: true,
      evaluation,
      attempts: 0,
      rewritten: false,
      content,
      record,
      jsonPath,
    };
  }

  let evaluation = evaluateQualityGate({
    text: content,
    previousText,
    minWords: input.minWords,
    aiFlavorThreshold: config.aiFlavorThreshold ?? 60,
    minWordRatio: config.minWordRatio,
  });
  let attempts = 0;
  let rewritten = false;

  while (!evaluation.passed && config.onFail === "retry" && attempts < (config.maxRetries ?? 0) && input.rewrite) {
    attempts += 1;
    const next = await input.rewrite(content, previousText);
    if (!next || next === content) break;
    content = next;
    rewritten = true;
    evaluation = evaluateQualityGate({
      text: content,
      previousText,
      minWords: input.minWords,
      aiFlavorThreshold: config.aiFlavorThreshold ?? 60,
      minWordRatio: config.minWordRatio,
    });
  }

  if (rewritten && input.persist !== false) {
    await writeChapterBody(input.bookDir, input.chapterNumber, content);
  }

  const record = buildRecord(input, config, evaluation, attempts, evaluatedAt, false);
  const jsonPath = input.persist === false
    ? undefined
    : await appendQualityGateRecord(input.bookDir, input.bookId, record);

  if (!evaluation.passed) {
    const detail = evaluation.reasons.join("; ") || "failed";
    input.logger?.warn(`quality gate failed for ${input.bookId} ch.${input.chapterNumber}: ${detail}`);
    if (config.onFail === "pause") {
      throw new QualityGatePauseError(input.chapterNumber, evaluation.reasons);
    }
  }

  return {
    skipped: false,
    passed: evaluation.passed,
    evaluation,
    attempts,
    rewritten,
    content,
    record,
    jsonPath,
  };
}

function buildRecord(
  input: RunQualityGateInput,
  config: QualityGateConfig,
  evaluation: QualityGateEvaluation,
  attempts: number,
  evaluatedAt: string,
  skipped: boolean,
): QualityGateChapterRecord {
  return {
    chapterNumber: input.chapterNumber,
    passed: evaluation.passed,
    score: evaluation.score,
    wordCount: evaluation.wordCount,
    minWords: input.minWords,
    aiFlavorThreshold: config.aiFlavorThreshold ?? 60,
    reasons: evaluation.reasons,
    onFail: config.onFail ?? "warn",
    attempts,
    ...(skipped ? { skipped: true } : {}),
    evaluatedAt,
  };
}

async function readPreviousChapterBody(bookDir: string, chapterNumber: number): Promise<string> {
  if (chapterNumber <= 1) return "";
  try {
    return (await readChapterMarkdown(bookDir, chapterNumber - 1)).body;
  } catch {
    return "";
  }
}

async function writeChapterBody(bookDir: string, chapterNumber: number, body: string): Promise<void> {
  const chapter = await readChapterMarkdown(bookDir, chapterNumber);
  if (chapter.body === body) return;
  await writeFile(chapter.filePath, replaceChapterBody(chapter.raw, body), "utf-8");
}
