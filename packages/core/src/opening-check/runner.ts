import type { AgentContext } from "../agents/base.js";
import { chatCompletion } from "../llm/provider.js";
import { readChapterMarkdown } from "../pipeline/chapter-files.js";
import type { Logger } from "../utils/logger.js";
import { OPENING_CHECK_ITEMS } from "./checklist.js";
import {
  evidenceSupported,
  findBackgroundDumpSpans,
} from "./evidence.js";
import {
  deriveHardGateItems,
  evaluateOpeningHardGate,
  resolveOpeningCheckEnabled,
  resolveOpeningCheckHardGate,
  type OpeningCheckOverride,
} from "./hard-gate.js";
import {
  applyQuoteVerification,
  fillChecklistItems,
  parseOpeningCheckResponse,
} from "./parse.js";
import { buildOpeningCheckUserPrompt, OPENING_CHECK_SYSTEM_PROMPT } from "./prompt.js";
import { writeOpeningCheckReport } from "./report.js";
import type {
  OpeningCheckBinding,
  OpeningCheckChapter,
  OpeningCheckItemResult,
  OpeningCheckLlm,
  OpeningCheckReport,
} from "./types.js";

export const OPENING_CHECK_CHAPTER_LIMIT = 3;

export { resolveOpeningCheckEnabled, resolveOpeningCheckHardGate } from "./hard-gate.js";

export interface RunOpeningCheckInput {
  readonly bookId: string;
  readonly bookDir: string;
  readonly projectOpeningCheck?: OpeningCheckOverride;
  readonly bookOpeningCheck?: OpeningCheckOverride;
  readonly llm?: OpeningCheckLlm;
  readonly agentCtx?: AgentContext;
  readonly binding: OpeningCheckBinding;
  readonly now?: () => string;
  readonly persist?: boolean;
  readonly logger?: Logger;
}

export interface RunOpeningCheckResult {
  readonly skipped: boolean;
  readonly skipReason?: string;
  readonly report: OpeningCheckReport;
  readonly jsonPath?: string;
  readonly mdPath?: string;
}

export async function loadOpeningChapters(bookDir: string): Promise<OpeningCheckChapter[]> {
  const chapters: OpeningCheckChapter[] = [];
  for (let number = 1; number <= OPENING_CHECK_CHAPTER_LIMIT; number++) {
    try {
      const chapter = await readChapterMarkdown(bookDir, number);
      chapters.push({ number, body: chapter.body });
    } catch {
      // Review whatever exists in 1..3; a hole does not stop later chapters.
    }
  }
  return chapters;
}

export async function runOpeningCheck(input: RunOpeningCheckInput): Promise<RunOpeningCheckResult> {
  const enabled = resolveOpeningCheckEnabled(input.projectOpeningCheck, input.bookOpeningCheck);
  const hardGateEnabled = resolveOpeningCheckHardGate(input.projectOpeningCheck, input.bookOpeningCheck);
  const generatedAt = input.now?.() ?? new Date().toISOString();
  if (!enabled) {
    const skipReason = "开篇检查已关闭（openingCheck.enabled=false）";
    const report: OpeningCheckReport = {
      bookId: input.bookId,
      chapters: [],
      items: [],
      generatedAt,
      binding: input.binding,
      skipped: true,
      skipReason,
    };
    const hardGate = evaluateOpeningHardGate(report, { enabled: false, hardGate: hardGateEnabled });
    return { skipped: true, skipReason, report: { ...report, hardGate } };
  }

  const chapters = await loadOpeningChapters(input.bookDir);
  if (chapters.length === 0) {
    throw new Error(`没有可检查的章节（${input.bookDir}/chapters 前 ${OPENING_CHECK_CHAPTER_LIMIT} 章为空）`);
  }

  const raw = await completeOpeningCheck(input, chapters);
  const parsed = parseOpeningCheckResponse(raw);
  const body = chapters.map((chapter) => chapter.body).join("\n");
  let items = applyQuoteVerification(fillChecklistItems(parsed), body, evidenceSupported);
  items = applyBackgroundPrecheck(items, chapters);
  items = deriveHardGateItems(items);

  const draft: OpeningCheckReport = {
    bookId: input.bookId,
    chapters: chapters.map((chapter) => chapter.number),
    items,
    generatedAt,
    binding: input.binding,
  };
  const hardGate = evaluateOpeningHardGate(draft, { enabled: true, hardGate: hardGateEnabled });
  const report: OpeningCheckReport = { ...draft, hardGate };

  if (input.persist === false) {
    return { skipped: false, report };
  }
  const paths = await writeOpeningCheckReport(input.bookDir, report);
  return { skipped: false, report, jsonPath: paths.jsonPath, mdPath: paths.mdPath };
}

export async function maybeRunOpeningCheckAfterChapter(input: {
  readonly bookId: string;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly projectOpeningCheck?: OpeningCheckOverride;
  readonly bookOpeningCheck?: OpeningCheckOverride;
  readonly agentCtx: AgentContext;
  readonly logger?: Logger;
}): Promise<RunOpeningCheckResult | undefined> {
  if (input.chapterNumber !== OPENING_CHECK_CHAPTER_LIMIT) return undefined;
  const binding: OpeningCheckBinding = {
    service: input.agentCtx.client.service ?? "custom",
    model: input.agentCtx.model,
  };
  try {
    const result = await runOpeningCheck({
      bookId: input.bookId,
      bookDir: input.bookDir,
      projectOpeningCheck: input.projectOpeningCheck,
      bookOpeningCheck: input.bookOpeningCheck,
      agentCtx: input.agentCtx,
      binding,
      logger: input.logger,
    });
    if (result.skipped) {
      input.logger?.info(result.skipReason ?? "opening-check skipped");
    } else {
      input.logger?.info(`opening-check wrote ${result.mdPath ?? "story/opening-check.md"}`);
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.logger?.warn(`opening-check failed (non-blocking): ${message}`);
    return undefined;
  }
}

async function completeOpeningCheck(
  input: RunOpeningCheckInput,
  chapters: readonly OpeningCheckChapter[],
): Promise<string> {
  const user = buildOpeningCheckUserPrompt(chapters);
  if (input.llm) {
    return input.llm.complete({ system: OPENING_CHECK_SYSTEM_PROMPT, user });
  }
  if (input.agentCtx) {
    const response = await chatCompletion(
      input.agentCtx.client,
      input.agentCtx.model,
      [
        { role: "system", content: OPENING_CHECK_SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
      {
        temperature: 0.2,
        signal: input.agentCtx.signal,
        onStreamProgress: input.agentCtx.onStreamProgress,
      },
    );
    return response.content;
  }
  throw new Error("opening-check LLM is not configured");
}

export function applyBackgroundPrecheck(
  items: readonly OpeningCheckItemResult[],
  chapters: readonly OpeningCheckChapter[],
): OpeningCheckItemResult[] {
  const spans = findBackgroundDumpSpans(chapters);
  if (spans.length === 0) return [...items];
  return items.map((item) => {
    if (item.id !== 1) return item;
    const suggestion = item.suggestion.trim()
      ? item.suggestion
      : "纯背景交代超过 300 字，拆进对话、动作或当场冲突，不要一口气铺设定。";
    return {
      ...item,
      verdict: "fail",
      suggestion,
      backgroundSpans: spans,
    };
  });
}

export function openingCheckItemCount(): number {
  return OPENING_CHECK_ITEMS.length;
}
