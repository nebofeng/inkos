import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import {
  DEAI_REWRITE_AGENT,
  StateManager,
  analyzeText,
  createLLMClient,
  resolveAgentLLMConfig,
  runDeAI,
} from "@actalk/inkos-core";
import { findProjectRoot, loadConfig, log, logError, resolveBookId } from "../utils.js";

const SCORE_HINT = "hint: `inkos ai-flavor score` is deprecated; use `inkos deai score`.";
const REWRITE_HINT = "hint: `inkos ai-flavor rewrite` is deprecated; use `inkos deai run`.";

export const aiFlavorCommand = new Command("ai-flavor")
  .description("Deprecated alias of inkos deai score/run (same runDeAI path)");

aiFlavorCommand
  .command("score")
  .description("Score AI-flavor of a chapter (no model call)")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--chapter <n>", "Chapter number (defaults to latest)")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts: { chapter?: string; json?: boolean }) => {
    try {
      const root = findProjectRoot();
      await loadConfig({ projectRoot: root, requireApiKey: false });
      const bookId = await resolveBookId(bookIdArg, root);
      const state = new StateManager(root);
      const bookDir = state.bookDir(bookId);
      const chapterNumber = await resolveChapterNumber(state, bookId, opts.chapter);
      const result = await runDeAI({
        bookId,
        bookDir,
        chapterNumber,
        projectRoot: root,
        mode: "score-only",
        persist: false,
        persistDeAI: false,
      });
      const metrics = analyzeText(result.content);
      log(SCORE_HINT);
      if (opts.json) {
        log(JSON.stringify({
          bookId,
          chapter: chapterNumber,
          score: result.score,
          passed: result.passed,
          reasons: result.reasons,
          skill: result.config.skill,
          metrics,
        }, null, 2));
        return;
      }
      log(`AI 味 ${metrics.score}/100  第${chapterNumber}章  ${metrics.chars}字`);
      for (const issue of metrics.issues) log(`- ${issue}`);
      if (metrics.flaggedParagraphs.length > 0) {
        log(`flagged: ${metrics.flaggedParagraphs.join(", ")}`);
      }
    } catch (error) {
      logError(`AI-flavor score failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

aiFlavorCommand
  .command("rewrite")
  .description("Rewrite AI-flavored paragraphs via runDeAI")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .requiredOption("--chapter <n>", "Chapter number")
  .option("--out <file>", "Write merged text to this file instead of the chapter")
  .option("--dry-run", "Do not modify the chapter file")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts: {
    chapter: string;
    out?: string;
    dryRun?: boolean;
    json?: boolean;
  }) => {
    try {
      const root = findProjectRoot();
      const config = await loadConfig({ projectRoot: root });
      const bookId = await resolveBookId(bookIdArg, root);
      const state = new StateManager(root);
      const bookDir = state.bookDir(bookId);
      const chapterNumber = Number.parseInt(opts.chapter, 10);
      if (!Number.isInteger(chapterNumber) || chapterNumber < 1) {
        throw new Error(`Invalid chapter number: ${opts.chapter}`);
      }
      const persist = !opts.dryRun && !opts.out;
      const binding = resolveAgentLLMConfig({
        base: config.llm,
        modelOverrides: config.modelOverrides,
        agentName: DEAI_REWRITE_AGENT,
      });
      const result = await runDeAI({
        bookId,
        bookDir,
        chapterNumber,
        projectRoot: root,
        persist,
        persistDeAI: persist,
        rewriteCtx: {
          client: createLLMClient(binding),
          model: binding.model,
          projectRoot: root,
          bookId,
        },
      });
      if (opts.out) {
        await writeFile(opts.out, result.content, "utf-8");
      }
      const wroteChapter = persist && result.rewritten && result.content !== result.originalContent;
      const before = analyzeText(result.originalContent);
      const after = analyzeText(result.content);
      log(REWRITE_HINT);
      if (opts.json) {
        log(JSON.stringify({
          bookId,
          chapter: chapterNumber,
          score: result.score,
          rewritten: result.rewritten,
          skill: result.config.skill,
          before,
          after,
          wroteChapter,
          out: opts.out,
        }, null, 2));
        return;
      }
      log(`AI 味 ${before.score} → ${after.score}  第${chapterNumber}章`);
      if (opts.out) log(`wrote ${opts.out}`);
      else if (opts.dryRun) log("dry-run: chapter not modified");
      else if (wroteChapter) log("chapter updated");
      else log("chapter unchanged");
    } catch (error) {
      logError(`AI-flavor rewrite failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

async function resolveChapterNumber(
  state: StateManager,
  bookId: string,
  raw?: string,
): Promise<number> {
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid chapter number: ${raw}`);
    return n;
  }
  const next = await state.getNextChapterNumber(bookId);
  if (next < 2) throw new Error("No chapters to score.");
  return next - 1;
}
