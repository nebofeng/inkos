/**
 * The ONLY entry points the 1.8.0 pipeline calls. Each call site is marked
 * with a "STORY-GRAPH HOOK" comment:
 *
 *   (A) pipeline/runner.ts  _executeNextChapterLocked, right after
 *       persistChapterArtifacts → runStoryGraphAfterChapter
 *   (B) agents/composer.ts  composeGovernedChapter, after BM25 memory
 *       selection → input.storyGraphContextProvider (built by
 *       storyGraphContextProviderFor in runner.createGovernedArtifacts)
 *   (C) state/manager.ts    rollbackToChapter (also used by chapter delete),
 *       after memory.db is dropped → pruneStoryGraphOnRollback
 *
 * All hooks are no-ops when the feature flag is off and never throw into the
 * pipeline.
 */
import { access } from "node:fs/promises";
import { resolveStoryGraphConfig, type StoryGraphConfig } from "./config.js";
import { HeuristicChapterGraphExtractor, LLMChapterGraphExtractor, type GraphCompletion } from "./extract.js";
import { graphJournalDir } from "./journal.js";
import { retrieveStoryGraphContext, type GraphContextEntry } from "./retrieval.js";
import { extractChapterToGraph, findStaleGraphChapters, pruneStoryGraphAfter } from "./service.js";
import type { ChapterGraphExtractor } from "./types.js";

export interface StoryGraphHookLogger {
  info?(message: string): void;
  warn?(message: string): void;
}

export interface StoryGraphContextRequest {
  readonly chapterNumber: number;
  readonly goal: string;
  readonly outlineNode?: string;
  readonly mustKeep?: ReadonlyArray<string>;
  readonly coveredChapters: ReadonlyArray<number>;
}

export type StoryGraphContextProvider = (request: StoryGraphContextRequest) => Promise<{
  readonly entries: ReadonlyArray<GraphContextEntry>;
  readonly notes: ReadonlyArray<string>;
}>;

export function createStoryGraphExtractor(
  config: StoryGraphConfig,
  completion?: { readonly complete: GraphCompletion; readonly model?: string },
): ChapterGraphExtractor {
  if (config.extractor === "heuristic" || !completion) return new HeuristicChapterGraphExtractor();
  return new LLMChapterGraphExtractor(completion.complete, { model: completion.model, maxChapterChars: config.maxChapterChars });
}

/** Hook (A): extract the just-persisted chapter (+ refresh revised ones). */
export async function runStoryGraphAfterChapter(params: {
  readonly projectRoot: string;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly language?: "zh" | "en";
  /** Lazily built so no agent/client is created while the flag is off. */
  readonly completion: () => { readonly complete: GraphCompletion; readonly model?: string };
  readonly logger?: StoryGraphHookLogger;
  readonly config?: StoryGraphConfig;
}): Promise<void> {
  const config = params.config ?? resolveStoryGraphConfig(params.projectRoot);
  if (!config.enabled) return;
  try {
    const extractor = createStoryGraphExtractor(config, config.extractor === "llm" ? params.completion() : undefined);
    const result = await extractChapterToGraph({
      bookDir: params.bookDir,
      chapter: params.chapterNumber,
      extractor,
      language: params.language,
    });
    const x = result.record.extraction;
    params.logger?.info?.(
      `[story-graph] chapter ${params.chapterNumber}: ${x.characters.length} characters, ${x.relationships.length} relationships, `
      + `${x.events.length} events, ${x.dialogues.length} dialogue lines, ${result.record.conflicts.length} truth conflicts`,
    );
    if (config.refreshStaleLimit > 0) {
      const stale = (await findStaleGraphChapters(params.bookDir, params.chapterNumber)).slice(-config.refreshStaleLimit);
      for (const chapter of stale) {
        await extractChapterToGraph({ bookDir: params.bookDir, chapter, extractor, language: params.language, force: true });
        params.logger?.info?.(`[story-graph] re-extracted revised chapter ${chapter}`);
      }
    }
  } catch (error) {
    params.logger?.warn?.(`[story-graph] extraction skipped for chapter ${params.chapterNumber}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Hook (B) factory: undefined when disabled so the composer does nothing. */
export function storyGraphContextProviderFor(params: {
  readonly projectRoot: string;
  readonly bookDir: string;
  readonly language?: "zh" | "en";
  readonly config?: StoryGraphConfig;
}): StoryGraphContextProvider | undefined {
  const config = params.config ?? resolveStoryGraphConfig(params.projectRoot);
  if (!config.enabled) return undefined;
  return async (request) => {
    try {
      const context = await retrieveStoryGraphContext({
        bookDir: params.bookDir,
        chapterNumber: request.chapterNumber,
        goal: request.goal,
        outlineNode: request.outlineNode,
        mustKeep: request.mustKeep,
        language: params.language,
        config,
        coveredChapters: request.coveredChapters,
        writeTrace: true,
      });
      const trace = context.trace;
      return {
        entries: context.entries,
        notes: [
          `story-graph:${trace.note ?? "ok"}:seeds=${trace.seeds.join("|")}:chars=${trace.expanded.length}:tokens=${trace.usedTokens}/${trace.budgetTokens}`,
          ...(trace.suppressedConflicts.length > 0 ? [`story-graph:truth-overrides=${trace.suppressedConflicts.length}`] : []),
        ],
      };
    } catch (error) {
      return { entries: [], notes: [`story-graph-unavailable:${error instanceof Error ? error.message : String(error)}`] };
    }
  };
}

/** Hook (C): rollback / chapter delete. Runs regardless of the flag (cheap no-op without a journal). */
export async function pruneStoryGraphOnRollback(bookDir: string, targetChapter: number): Promise<void> {
  try {
    await access(graphJournalDir(bookDir));
  } catch {
    return;
  }
  try {
    await pruneStoryGraphAfter(bookDir, targetChapter);
  } catch {
    // Journal entries beyond the chapter index are ignored by retrieval
    // (rows are filtered by chapter < N), so a failed prune is not fatal.
  }
}
