/**
 * Semantic cleanup (deslop) after a chapter audit succeeds.
 *
 * Production should ride the novel/writing LLM channel
 * (`AGENT_KEY_PURPOSE=novel`), not the DEV coding key. Do not embed keys here.
 */

import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentContext } from "../agents/base.js";
import type { AuditIssue } from "../agents/continuity.js";
import type { AgentSkill } from "../skills/types.js";
import type { ActivatedSkillGuidance, ActivatedSkillResource } from "../agent/skill-tool.js";
import type { DeslopConfig } from "../models/project.js";
import { DEFAULT_DESLOP_CONFIG } from "../models/project.js";
import type { DeslopStatus } from "../models/chapter.js";
import type { Logger } from "../utils/logger.js";
import { countChapterLength } from "../utils/length-metrics.js";
import {
  preDeslopSidecarName,
  readChapterMarkdown,
  replaceChapterBody,
} from "./chapter-files.js";

export const DESLOP_SKILL_ID = "inkos-story-deslop";
export const DEFAULT_DESLOP_TIMEOUT_MS = 4 * 60 * 1000;

const DESLOP_ISSUE: AuditIssue = {
  severity: "warning",
  category: "semantic-cleanup",
  description: "Remove generic, mechanical, over-explained, or AI-flavored prose while preserving plot, viewpoint, and character voice.",
  suggestion: "Diagnose by function and effect, not banned-word deletion. Restore concrete cause and character-specific behavior.",
};

export interface DeslopResult {
  readonly chapterNumber: number;
  readonly status: Exclude<DeslopStatus, "pending">;
  readonly content: string;
  readonly wordCount: number;
  readonly attempts: number;
  readonly originalPath?: string;
  readonly error?: string;
}

export interface DeslopReviser {
  reviseChapter(
    bookDir: string,
    chapterContent: string,
    chapterNumber: number,
    issues: ReadonlyArray<AuditIssue>,
    mode?: "auto" | "polish" | "rewrite" | "rework" | "anti-detect" | "spot-fix",
    genre?: string,
  ): Promise<{ readonly revisedContent: string; readonly wordCount: number }>;
}

export interface RunDeslopInput {
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly config?: DeslopConfig;
  readonly reviser: DeslopReviser;
  readonly logger?: Logger;
  readonly genre?: string;
  readonly timeoutMs?: number;
  readonly now?: () => string;
}

export async function loadDeslopSkill(): Promise<AgentSkill | undefined> {
  const { loadBuiltinAgentSkills } = await import("../skills/builtin-loader.js");
  const { skills } = await loadBuiltinAgentSkills();
  return skills.find((skill) => skill.id === DESLOP_SKILL_ID);
}

export async function loadDeslopSkillGuidance(): Promise<ActivatedSkillGuidance[]> {
  const skill = await loadDeslopSkill();
  if (!skill) return [];
  const resources: ActivatedSkillResource[] = [];
  if (skill.baseDir) {
    try {
      const { readFile } = await import("node:fs/promises");
      const body = await readFile(join(skill.baseDir, "references", "semantic-cleanup.md"), "utf-8");
      resources.push({
        path: "references/semantic-cleanup.md",
        heading: "Semantic cleanup rubric",
        body,
        charStart: 0,
        charEnd: body.length,
      });
    } catch {
      // Skill body still applies without the reference file.
    }
  }
  return [{ skill, resources }];
}

export async function createDeslopReviser(ctx: AgentContext): Promise<DeslopReviser> {
  const { ReviserAgent } = await import("../agents/reviser.js");
  const activatedSkills = [
    ...(ctx.activatedSkills ?? []),
    ...await loadDeslopSkillGuidance(),
  ];
  return new ReviserAgent({ ...ctx, activatedSkills });
}

export async function runDeslop(input: RunDeslopInput): Promise<DeslopResult> {
  const config = input.config ?? DEFAULT_DESLOP_CONFIG;
  const chapter = await readChapterMarkdown(input.bookDir, input.chapterNumber);
  const originalBody = chapter.body;
  const originalWordCount = countChapterLength(originalBody, "zh_chars");

  if (!config.enabled) {
    return {
      chapterNumber: input.chapterNumber,
      status: "skipped",
      content: originalBody,
      wordCount: originalWordCount,
      attempts: 0,
    };
  }

  const maxRetries = Math.max(1, config.maxRetries);
  const timeoutMs = input.timeoutMs ?? DEFAULT_DESLOP_TIMEOUT_MS;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const output = await withTimeout(
        input.reviser.reviseChapter(
          input.bookDir,
          originalBody,
          input.chapterNumber,
          [DESLOP_ISSUE],
          "polish",
          input.genre,
        ),
        timeoutMs,
        `deslop chapter ${input.chapterNumber} attempt ${attempt}`,
      );
      const revised = output.revisedContent.trim();
      if (!revised) {
        lastError = "reviser returned empty content";
        input.logger?.warn(`deslop empty result for chapter ${input.chapterNumber} (attempt ${attempt}/${maxRetries})`);
        continue;
      }

      if (config.keepOriginal) {
        const sidecarPath = join(input.bookDir, "chapters", preDeslopSidecarName(chapter.fileName));
        await copyFile(chapter.filePath, sidecarPath);
      }
      await writeFile(chapter.filePath, replaceChapterBody(chapter.raw, revised), "utf-8");
      return {
        chapterNumber: input.chapterNumber,
        status: "ok",
        content: revised,
        wordCount: output.wordCount || countChapterLength(revised, "zh_chars"),
        attempts: attempt,
        originalPath: config.keepOriginal
          ? join("chapters", preDeslopSidecarName(chapter.fileName))
          : undefined,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      input.logger?.warn(`deslop failed for chapter ${input.chapterNumber} (attempt ${attempt}/${maxRetries}): ${lastError}`);
    }
  }

  return {
    chapterNumber: input.chapterNumber,
    status: "failed",
    content: originalBody,
    wordCount: originalWordCount,
    attempts: maxRetries,
    error: lastError ?? "deslop failed",
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
