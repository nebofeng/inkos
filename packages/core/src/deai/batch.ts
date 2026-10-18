/**
 * Batch de-AI over existing chapters. Every chapter goes through `runDeAI`
 * (no second pipeline). Writes are atomic (temp + rename); apply backups
 * live in `chapters/.deai-bak/<ts>/`.
 *
 * Cost cap: LLMClient has no reliable USD accounting. We estimate tokens as
 * non-whitespace chars (CJK-conservative) × REWRITE_TOKEN_MULTIPLIER, then
 * apply DEAI_BATCH_USD_PER_1K_TOKENS. Stop before starting a chapter that
 * would exceed maxCostUsd; state stays resumable.
 */

import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeText } from "../ai-flavor/metrics.js";
import { isCanonicalChapterMarkdownFile, preDeslopSidecarName, readChapterMarkdown, replaceChapterBody } from "../pipeline/chapter-files.js";
import type { AgentContext } from "../agents/base.js";
import type { BookConfig } from "../models/book.js";
import type { Logger } from "../utils/logger.js";
import { runDeAI } from "./run.js";
import type { DeAIInput, DeAIRewriter } from "./types.js";

export const DEAI_BATCH_CONCURRENCY_MAX = 3;
export const DEAI_BATCH_CONCURRENCY_DEFAULT = 1;
/** Conservative mid-range chat rate used only for the estimated-token cap. */
export const DEAI_BATCH_USD_PER_1K_TOKENS = 0.002;
/** Prompt + completion relative to chapter body tokens. */
export const DEAI_BATCH_REWRITE_TOKEN_MULTIPLIER = 2.5;

export type DeAIBatchMode = "score-only" | "dry-run" | "preview" | "apply";
export type DeAIBatchChapterStatus = "pending" | "ok" | "warn" | "failed" | "skipped";

export interface DeAIBatchChapterState {
  status: DeAIBatchChapterStatus;
  scoreBefore: number | null;
  scoreAfter: number | null;
  written: boolean;
  error?: string;
  wouldRewrite?: boolean;
  flaggedParagraphs?: readonly number[];
}

export interface DeAIBatchStateFile {
  runId: string;
  ts: string;
  mode: DeAIBatchMode;
  range: string;
  chapters: Record<string, DeAIBatchChapterState>;
}

export interface DeAIBatchProgress {
  readonly chapter: number;
  readonly phase: "start" | "done";
  readonly status?: DeAIBatchChapterStatus;
  readonly inflight: number;
}

export interface DeAIBatchInput {
  readonly projectRoot: string;
  readonly bookId: string;
  readonly range: string;
  readonly mode: DeAIBatchMode;
  readonly skill?: string;
  readonly threshold?: number;
  readonly concurrency?: number;
  readonly maxCostUsd?: number;
  readonly resume?: boolean;
  readonly force?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: DeAIBatchProgress) => void;
  readonly now?: () => Date;
  readonly rewriter?: DeAIRewriter;
  readonly rewriteCtx?: AgentContext;
  readonly homeDir?: string;
  readonly logger?: Logger;
}

export interface DeAIBatchRow {
  readonly chapter: number;
  readonly status: DeAIBatchChapterStatus;
  readonly scoreBefore: number | null;
  readonly scoreAfter: number | null;
  readonly written: boolean;
  readonly error?: string;
  readonly wouldRewrite?: boolean;
  readonly flaggedParagraphs?: readonly number[];
}

export interface DeAIBatchReport {
  readonly runId: string;
  readonly ts: string;
  readonly bookId: string;
  readonly mode: DeAIBatchMode;
  readonly range: string;
  readonly chapters: Record<string, DeAIBatchChapterState>;
  readonly rows: readonly DeAIBatchRow[];
  readonly estimatedCostUsd: number;
  readonly stoppedReason?: "aborted" | "cost-cap";
  readonly costNote: string;
}

const COST_NOTE =
  "No reliable LLM USD accounting is wired through the client; the cap uses estimated tokens (non-whitespace chars × 2.5 × $0.002/1k).";

export function clampDeAIBatchConcurrency(value: number | undefined): number {
  if (value == null || !Number.isFinite(value) || value < 1) return DEAI_BATCH_CONCURRENCY_DEFAULT;
  return Math.min(Math.floor(value), DEAI_BATCH_CONCURRENCY_MAX);
}

export function estimateDeAIBatchCostUsd(chapterBody: string): number {
  const tokens = (chapterBody || "").replace(/\s/g, "").length;
  return (tokens * DEAI_BATCH_REWRITE_TOKEN_MULTIPLIER / 1000) * DEAI_BATCH_USD_PER_1K_TOKENS;
}

export function parseDeAIRange(range: string, existing: readonly number[]): number[] {
  const existingSet = new Set(existing);
  const trimmed = range.trim();
  if (!trimmed) throw new Error("Range is empty");
  if (trimmed.toLowerCase() === "all") {
    if (existing.length === 0) throw new Error("No chapters found");
    return [...existing].sort((a, b) => a - b);
  }

  const requested: number[] = [];
  const seen = new Set<number>();
  for (const rawPart of trimmed.split(",")) {
    const token = rawPart.trim();
    if (!token) continue;
    const single = token.match(/^(\d+)$/);
    const span = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (single) {
      const n = Number(single[1]);
      if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid range token: ${token}`);
      if (!seen.has(n)) {
        requested.push(n);
        seen.add(n);
      }
      continue;
    }
    if (span) {
      const start = Number(span[1]);
      const end = Number(span[2]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        throw new Error(`Invalid range: ${token}`);
      }
      for (let n = start; n <= end; n++) {
        if (!seen.has(n)) {
          requested.push(n);
          seen.add(n);
        }
      }
      continue;
    }
    throw new Error(`Invalid range token: ${token}`);
  }
  if (requested.length === 0) throw new Error("Range is empty");
  const missing = requested.filter((n) => !existingSet.has(n));
  if (missing.length > 0) {
    throw new Error(`Range includes chapters that do not exist: ${missing.join(", ")}`);
  }
  return requested;
}

export async function listExistingChapterNumbers(bookDir: string): Promise<number[]> {
  const chaptersDir = join(bookDir, "chapters");
  const files = await readdir(chaptersDir).catch(() => [] as string[]);
  const nums = new Set<number>();
  for (const file of files) {
    if (!isCanonicalChapterMarkdownFile(file)) continue;
    const match = file.match(/^(\d+)[_-]/);
    if (match) nums.add(Number(match[1]));
  }
  return [...nums].sort((a, b) => a - b);
}

export function deAIBatchStatePath(bookDir: string): string {
  return join(bookDir, "story", "deai-batch.json");
}

export function deAIBackupDir(bookDir: string, ts: string): string {
  return join(bookDir, "chapters", ".deai-bak", ts);
}

export function deAIPreviewPath(bookDir: string, chapterNumber: number): string {
  return join(bookDir, "story", "deai-preview", `${chapterNumber}.md`);
}

export async function listDeAIBackups(input: {
  readonly projectRoot: string;
  readonly bookId: string;
}): Promise<string[]> {
  const bookDir = bookDirOf(input.projectRoot, input.bookId);
  const root = join(bookDir, "chapters", ".deai-bak");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export async function rollbackDeAIBatch(input: {
  readonly projectRoot: string;
  readonly bookId: string;
  readonly from: string;
}): Promise<{ readonly restored: string[]; readonly from: string }> {
  const bookDir = bookDirOf(input.projectRoot, input.bookId);
  const from = input.from.trim();
  if (!from) throw new Error("Missing backup timestamp (--from)");
  const bakDir = deAIBackupDir(bookDir, from);
  const info = await stat(bakDir).catch(() => undefined);
  if (!info?.isDirectory()) {
    throw new Error(`No deAI backup at chapters/.deai-bak/${from}`);
  }
  const files = (await readdir(bakDir)).filter((file) => file.endsWith(".md") && !file.includes(".pre-deslop"));
  const chaptersDir = join(bookDir, "chapters");
  const restored: string[] = [];
  for (const file of files) {
    await copyFile(join(bakDir, file), join(chaptersDir, file));
    restored.push(file);
  }
  restored.sort();
  return { restored, from };
}

export async function runDeAIBatch(input: DeAIBatchInput): Promise<DeAIBatchReport> {
  const bookDir = bookDirOf(input.projectRoot, input.bookId);
  const book = await readBookConfig(bookDir);
  refusePausedOrDropped(book, input.force === true);

  const existing = await listExistingChapterNumbers(bookDir);
  const requested = parseDeAIRange(input.range, existing);
  const mode = input.mode;
  const concurrency = clampDeAIBatchConcurrency(input.concurrency);

  const previous = input.resume ? await readBatchState(bookDir) : undefined;
  const resumable = Boolean(previous && previous.mode === mode);
  const ts = resumable && previous ? previous.ts : formatBatchTs(input.now?.() ?? new Date());
  const runId = resumable && previous ? previous.runId : randomUUID();

  const chapters: Record<string, DeAIBatchChapterState> = {};
  if (resumable && previous) {
    for (const n of requested) {
      const key = String(n);
      chapters[key] = previous.chapters[key] ?? pendingState();
    }
  } else {
    for (const n of requested) chapters[String(n)] = pendingState();
  }

  const pending = requested.filter((n) => {
    const status = chapters[String(n)]?.status;
    return status !== "ok" && status !== "warn";
  });

  await writeBatchState(bookDir, { runId, ts, mode, range: input.range, chapters });

  const rewriteModes = mode === "preview" || mode === "apply";
  const costByChapter = new Map<number, number>();
  if (rewriteModes && input.maxCostUsd != null) {
    for (const n of pending) {
      const chapter = await readChapterMarkdown(bookDir, n);
      costByChapter.set(n, estimateDeAIBatchCostUsd(chapter.body));
    }
  }

  const project = await readJson(join(input.projectRoot, "inkos.json"));
  let estimatedCostUsd = 0;
  let stoppedReason: "aborted" | "cost-cap" | undefined;
  let nextIndex = 0;
  let inflight = 0;
  let stateLock = Promise.resolve();
  const withStateLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = stateLock;
    let release!: () => void;
    stateLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  };

  const take = (): number | undefined => {
    if (input.signal?.aborted) {
      stoppedReason ??= "aborted";
      return undefined;
    }
    if (nextIndex >= pending.length) return undefined;
    const n = pending[nextIndex]!;
    const add = costByChapter.get(n) ?? 0;
    if (input.maxCostUsd != null && estimatedCostUsd + add > input.maxCostUsd) {
      stoppedReason = "cost-cap";
      return undefined;
    }
    nextIndex += 1;
    estimatedCostUsd += add;
    inflight += 1;
    return n;
  };

  const worker = async (): Promise<void> => {
    while (true) {
      const n = take();
      if (n === undefined) return;
      input.onProgress?.({ chapter: n, phase: "start", inflight });
      let nextState: DeAIBatchChapterState;
      try {
        nextState = await processChapter({
          input,
          book,
          bookDir,
          project,
          chapterNumber: n,
          mode,
          ts,
        });
      } catch (error) {
        nextState = {
          status: "failed",
          scoreBefore: chapters[String(n)]?.scoreBefore ?? null,
          scoreAfter: null,
          written: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      inflight -= 1;
      await withStateLock(async () => {
        chapters[String(n)] = nextState;
        await writeBatchState(bookDir, { runId, ts, mode, range: input.range, chapters });
      });
      input.onProgress?.({
        chapter: n,
        phase: "done",
        status: nextState.status,
        inflight,
      });
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, Math.max(pending.length, 1)) }, () => worker());
  await Promise.all(workers);
  await writeBatchState(bookDir, { runId, ts, mode, range: input.range, chapters });

  const rows: DeAIBatchRow[] = requested.map((n) => toRow(n, chapters[String(n)] ?? pendingState()));
  return {
    runId,
    ts,
    bookId: input.bookId,
    mode,
    range: input.range,
    chapters,
    rows,
    estimatedCostUsd,
    stoppedReason,
    costNote: COST_NOTE,
  };
}

function pendingState(): DeAIBatchChapterState {
  return { status: "pending", scoreBefore: null, scoreAfter: null, written: false };
}

function toRow(chapter: number, state: DeAIBatchChapterState): DeAIBatchRow {
  return {
    chapter,
    status: state.status,
    scoreBefore: state.scoreBefore,
    scoreAfter: state.scoreAfter,
    written: state.written,
    ...(state.error ? { error: state.error } : {}),
    ...(state.wouldRewrite !== undefined ? { wouldRewrite: state.wouldRewrite } : {}),
    ...(state.flaggedParagraphs ? { flaggedParagraphs: state.flaggedParagraphs } : {}),
  };
}

async function processChapter(args: {
  readonly input: DeAIBatchInput;
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly project: unknown;
  readonly chapterNumber: number;
  readonly mode: DeAIBatchMode;
  readonly ts: string;
}): Promise<DeAIBatchChapterState> {
  const { input, bookDir, chapterNumber, mode, ts } = args;
  const loaded = await readChapterMarkdown(bookDir, chapterNumber);
  const originalRaw = loaded.raw;
  const originalBody = loaded.body;
  const beforeMetrics = analyzeText(originalBody);
  const scoreBefore = beforeMetrics.score;

  const deaiMode = mode === "preview" || mode === "apply" ? "full" : "score-only";
  const runInput: DeAIInput = {
    bookId: input.bookId,
    bookDir,
    chapterNumber,
    projectRoot: input.projectRoot,
    homeDir: input.homeDir,
    minWords: 0,
    text: originalBody,
    mode: deaiMode,
    persist: false,
    persistDeAI: false,
    signal: input.signal,
    logger: input.logger,
    project: asRecord(args.project),
    book: args.book,
    preset: args.book.platformPreset,
    overrides: {
      onFail: "warn",
      ...(input.skill ? { skill: input.skill } : {}),
      ...(input.threshold != null ? { aiFlavorThreshold: input.threshold } : {}),
    },
    rewriter: input.rewriter,
    rewriteCtx: input.rewriteCtx,
  };

  const result = await runDeAI(runInput);
  const scoreAfter = result.score;
  const wouldRewrite = !result.passed && result.config.rewriteEnabled;
  const flaggedParagraphs = beforeMetrics.flaggedParagraphs;

  if (mode === "score-only") {
    return {
      status: "ok",
      scoreBefore,
      scoreAfter,
      written: false,
    };
  }

  if (mode === "dry-run") {
    return {
      status: "ok",
      scoreBefore,
      scoreAfter,
      written: false,
      wouldRewrite,
      flaggedParagraphs,
    };
  }

  const status = result.status === "warned" ? "warn" : result.status === "failed" ? "failed" : "ok";
  const changed = result.rewritten && result.content !== originalBody;

  if (mode === "preview") {
    if (changed) {
      const previewPath = deAIPreviewPath(bookDir, chapterNumber);
      await mkdir(join(bookDir, "story", "deai-preview"), { recursive: true });
      await writeAtomic(previewPath, replaceChapterBody(originalRaw, result.content));
    }
    return { status, scoreBefore, scoreAfter, written: changed };
  }

  if (changed) {
    await backupChapter(bookDir, ts, loaded.fileName, loaded.filePath);
    if (result.config.keepOriginal) {
      await copyFile(loaded.filePath, join(bookDir, "chapters", preDeslopSidecarName(loaded.fileName)));
    }
    await writeAtomic(loaded.filePath, replaceChapterBody(originalRaw, result.content));
  }
  return { status, scoreBefore, scoreAfter, written: changed };
}

async function backupChapter(bookDir: string, ts: string, fileName: string, filePath: string): Promise<void> {
  const dir = deAIBackupDir(bookDir, ts);
  await mkdir(dir, { recursive: true });
  await copyFile(filePath, join(dir, fileName));
}

async function writeAtomic(target: string, content: string): Promise<void> {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, target);
}

async function readBatchState(bookDir: string): Promise<DeAIBatchStateFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(deAIBatchStatePath(bookDir), "utf-8")) as DeAIBatchStateFile;
    if (!parsed || typeof parsed !== "object" || !parsed.chapters) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function writeBatchState(bookDir: string, state: DeAIBatchStateFile): Promise<void> {
  const path = deAIBatchStatePath(bookDir);
  await mkdir(join(bookDir, "story"), { recursive: true });
  await writeAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
}

function refusePausedOrDropped(book: BookConfig, force: boolean): void {
  if (book.status !== "paused" && book.status !== "dropped") return;
  if (force) return;
  throw new Error(`Refusing deAI batch on ${book.status} book "${book.id}" (pass force to override)`);
}

async function readBookConfig(bookDir: string): Promise<BookConfig> {
  const raw = await readFile(join(bookDir, "book.json"), "utf-8").catch(() => "");
  if (!raw.trim()) throw new Error(`book.json not found in ${bookDir}`);
  return JSON.parse(raw) as BookConfig;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function bookDirOf(projectRoot: string, bookId: string): string {
  return join(projectRoot, "books", bookId);
}

function formatBatchTs(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}
