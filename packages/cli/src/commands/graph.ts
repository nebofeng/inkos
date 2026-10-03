/**
 * `inkos graph …` — story knowledge-graph maintenance (opt-in feature).
 *
 *   inkos graph status   [book]                       journal/projection coverage
 *   inkos graph backfill [book] [--from N] [--to N]   extract already-written chapters
 *   inkos graph rebuild  [book] --chapter N           re-extract one chapter
 *   inkos graph sync     [book]                       rebuild memory.db rows from the journal
 *   inkos graph eval     [book]                       old-vs-new retrieval on a temp copy
 *
 * Writing only USES the graph when inkos.json memory.graph.enabled (or
 * INKOS_STORY_GRAPH=1) is set; these commands work either way.
 */
import { Command } from "commander";
import {
  backfillStoryGraph,
  createStoryGraphExtractor,
  evaluateStoryGraphRetrieval,
  formatStoryGraphEvalSummary,
  getStoryGraphStatus,
  loadStoryGraphTruthRoster,
  NoiseInjectingExtractor,
  PipelineRunner,
  resolveStoryGraphConfig,
  StateManager,
  StoryGraphAgent,
  syncStoryGraph,
  type StoryGraphConfig,
} from "@actalk/inkos-core";
import { buildPipelineConfig, findProjectRoot, loadConfig, log, logError, resolveBookId } from "../utils.js";

type ExtractorChoice = "llm" | "heuristic";

async function resolveBook(bookIdArg: string | undefined) {
  const root = findProjectRoot();
  const bookId = await resolveBookId(bookIdArg, root);
  const state = new StateManager(root);
  const book = await state.loadBookConfig(bookId);
  return { root, bookId, bookDir: state.bookDir(bookId), language: (book.language === "en" ? "en" : "zh") as "zh" | "en" };
}

async function buildExtractor(root: string, bookId: string, choice: ExtractorChoice | undefined) {
  const config = resolveStoryGraphConfig(root);
  const effective: StoryGraphConfig = { ...config, extractor: choice ?? config.extractor };
  if (effective.extractor === "heuristic") return { config: effective, extractor: createStoryGraphExtractor(effective) };
  const projectConfig = await loadConfig();
  const runner = new PipelineRunner(buildPipelineConfig(projectConfig, root, { quiet: true }));
  const agent = new StoryGraphAgent(runner.createAgentContext("story-graph", bookId));
  return { config: effective, extractor: createStoryGraphExtractor(effective, { complete: agent.complete, model: agent.model }) };
}

function parseChapter(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) throw new Error(`Invalid chapter number: ${value}`);
  return n;
}

function fail(opts: { json?: boolean }, error: unknown): never {
  if (opts.json) log(JSON.stringify({ error: String(error) }));
  else logError(`story graph: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

function flagHint(root: string): string | undefined {
  return resolveStoryGraphConfig(root).enabled
    ? undefined
    : "note: memory.graph.enabled is off — the graph is built but not used when writing (set it in inkos.json or INKOS_STORY_GRAPH=1)";
}

export const graphCommand = new Command("graph")
  .description("Story knowledge graph (opt-in RAG): status, backfill, rebuild, sync, eval");

graphCommand
  .command("status")
  .argument("[book-id]")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts: { json?: boolean }) => {
    try {
      const { root, bookId, bookDir } = await resolveBook(bookIdArg);
      const status = await getStoryGraphStatus(bookDir);
      const config = resolveStoryGraphConfig(root);
      if (opts.json) {
        log(JSON.stringify({ bookId, enabled: config.enabled, config, ...status }, null, 2));
        return;
      }
      log(`book: ${bookId}  graph enabled for writing: ${config.enabled ? "yes" : "no"}`);
      log(`chapters: ${status.chapterFiles}  extracted: ${status.extracted.length}  missing: ${status.missing.length}  stale: ${status.stale.length}`);
      if (status.missing.length > 0) log(`missing: ${status.missing.join(", ")}`);
      if (status.stale.length > 0) log(`stale (text changed since extraction): ${status.stale.join(", ")}`);
      log(`rows: ${JSON.stringify(status.stats)}`);
    } catch (error) {
      fail(opts, error);
    }
  });

graphCommand
  .command("backfill")
  .argument("[book-id]")
  .option("--from <n>", "First chapter")
  .option("--to <n>", "Last chapter")
  .option("--force", "Re-extract even if up to date")
  .option("--extractor <kind>", "llm (default from config) or heuristic (offline, free)")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts: { from?: string; to?: string; force?: boolean; extractor?: ExtractorChoice; json?: boolean }) => {
    try {
      const { root, bookId, bookDir, language } = await resolveBook(bookIdArg);
      const { extractor } = await buildExtractor(root, bookId, opts.extractor);
      if (!opts.json) log(`backfilling story graph for "${bookId}" with ${extractor.id} (sequential)…`);
      const result = await backfillStoryGraph({
        bookDir,
        extractor,
        language,
        fromChapter: parseChapter(opts.from),
        toChapter: parseChapter(opts.to),
        force: opts.force,
        onProgress: opts.json ? undefined : (p) => log(`  [${p.index + 1}/${p.total}] chapter ${p.chapter}: ${p.status}${p.error ? ` (${p.error})` : ""}`),
      });
      if (opts.json) {
        log(JSON.stringify({ bookId, extractor: extractor.id, ...result }, null, 2));
      } else {
        log(`done: ${result.extracted.length} extracted, ${result.skipped.length} up to date, ${result.failed.length} failed`);
        const hint = flagHint(root);
        if (hint) log(hint);
      }
      if (result.failed.length > 0) process.exitCode = 1;
    } catch (error) {
      fail(opts, error);
    }
  });

graphCommand
  .command("rebuild")
  .argument("[book-id]")
  .requiredOption("--chapter <n>", "Chapter to re-extract")
  .option("--extractor <kind>", "llm or heuristic")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts: { chapter: string; extractor?: ExtractorChoice; json?: boolean }) => {
    try {
      const { root, bookId, bookDir, language } = await resolveBook(bookIdArg);
      const chapter = parseChapter(opts.chapter)!;
      const { extractor } = await buildExtractor(root, bookId, opts.extractor);
      const result = await backfillStoryGraph({ bookDir, extractor, language, fromChapter: chapter, toChapter: chapter, force: true });
      if (opts.json) log(JSON.stringify({ bookId, chapter, ...result }, null, 2));
      else log(result.failed.length > 0 ? `chapter ${chapter} failed: ${result.failed[0]!.error}` : `chapter ${chapter} re-extracted with ${extractor.id}`);
      if (result.failed.length > 0) process.exitCode = 1;
    } catch (error) {
      fail(opts, error);
    }
  });

graphCommand
  .command("sync")
  .argument("[book-id]")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts: { json?: boolean }) => {
    try {
      const { bookId, bookDir } = await resolveBook(bookIdArg);
      const result = await syncStoryGraph(bookDir);
      if (opts.json) log(JSON.stringify({ bookId, ...result }, null, 2));
      else log(`projection synced: ${result.replaced.length} chapters rewritten, ${result.removed.length} removed`);
    } catch (error) {
      fail(opts, error);
    }
  });

graphCommand
  .command("eval")
  .argument("[book-id]")
  .option("--extractor <kind>", "heuristic (default, offline) or llm (1 model call per chapter)")
  .option("--noise", "Inject fabricated quotes / wrong statuses / inverted relations to test truth-wins")
  .option("--hops <n>", "1 or 2")
  .option("--budget <tokens>", "Graph context token budget")
  .option("--from <n>", "First chapter to score")
  .option("--to <n>", "Last chapter to score")
  .option("--json", "Output JSON (per-chapter rows)")
  .action(async (bookIdArg: string | undefined, opts: {
    extractor?: ExtractorChoice; noise?: boolean; hops?: string; budget?: string; from?: string; to?: string; json?: boolean;
  }) => {
    try {
      const { root, bookId, bookDir, language } = await resolveBook(bookIdArg);
      const built = await buildExtractor(root, bookId, opts.extractor ?? "heuristic");
      const extractor = opts.noise
        ? new NoiseInjectingExtractor(built.extractor, await loadStoryGraphTruthRoster(bookDir))
        : built.extractor;
      const result = await evaluateStoryGraphRetrieval({
        bookDir,
        extractor,
        language,
        copy: true,
        fromChapter: parseChapter(opts.from),
        toChapter: parseChapter(opts.to),
        config: {
          ...(opts.hops ? { hops: opts.hops === "1" ? 1 : 2 } : {}),
          ...(opts.budget ? { budgetTokens: parseInt(opts.budget, 10) } : {}),
        },
        onProgress: opts.json ? undefined : (message) => log(`  ${message}`),
      });
      if (opts.json) log(JSON.stringify(result, null, 2));
      else log(formatStoryGraphEvalSummary(result));
    } catch (error) {
      fail(opts, error);
    }
  });
