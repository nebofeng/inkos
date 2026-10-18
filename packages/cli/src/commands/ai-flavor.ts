import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import {
  DEAI_REWRITE_AGENT,
  StateManager,
  analyzeText,
  createLLMClient,
  createLocalRewriteLlm,
  extractGlossaryFromBookDir,
  readChapterMarkdown,
  resolveAgentLLMConfig,
  rewriteFlaggedParagraphs,
  replaceChapterBody,
} from "@actalk/inkos-core";
import { findProjectRoot, loadConfig, log, logError, resolveBookId } from "../utils.js";

export const aiFlavorCommand = new Command("ai-flavor")
  .description("Score AI-flavor or locally rewrite flagged paragraphs");

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
      const chapter = await readChapterMarkdown(bookDir, chapterNumber);
      const previous = await readPreviousBody(bookDir, chapterNumber);
      const book = await state.loadBookConfig(bookId).catch(() => undefined);
      const metrics = analyzeText(chapter.body, previous, book?.chapterWordCount);
      if (opts.json) {
        log(JSON.stringify({ bookId, chapter: chapterNumber, metrics }, null, 2));
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
  .description("Locally rewrite AI-flavored paragraphs in a chapter")
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
      const chapter = await readChapterMarkdown(bookDir, chapterNumber);
      const previous = await readPreviousBody(bookDir, chapterNumber);
      const book = await state.loadBookConfig(bookId).catch(() => undefined);
      const glossary = await extractGlossaryFromBookDir(bookDir);
      const binding = resolveAgentLLMConfig({
        base: config.llm,
        modelOverrides: config.modelOverrides,
        agentName: DEAI_REWRITE_AGENT,
      });
      const client = createLLMClient(binding);
      const result = await rewriteFlaggedParagraphs({
        text: chapter.body,
        previousText: previous,
        targetWordCount: book?.chapterWordCount,
        glossary,
        llm: createLocalRewriteLlm({
          client,
          model: binding.model,
          projectRoot: root,
          bookId,
        }),
      });

      const writeChapter = !opts.dryRun && !opts.out;
      if (writeChapter && result.merged !== chapter.body) {
        await writeFile(chapter.filePath, replaceChapterBody(chapter.raw, result.merged), "utf-8");
      }
      if (opts.out) {
        await writeFile(opts.out, result.merged, "utf-8");
      }

      if (opts.json) {
        log(JSON.stringify({
          bookId,
          chapter: chapterNumber,
          changedIndices: result.changedIndices,
          revertedIndices: result.revertedIndices,
          skippedIndices: result.skippedIndices,
          before: result.before,
          after: result.after,
          wroteChapter: writeChapter && result.merged !== chapter.body,
          out: opts.out,
        }, null, 2));
        return;
      }
      log(`AI 味 ${result.before.score} → ${result.after.score}  第${chapterNumber}章`);
      log(`changed: ${result.changedIndices.join(", ") || "—"}`);
      log(`reverted: ${result.revertedIndices.join(", ") || "—"}`);
      if (opts.out) log(`wrote ${opts.out}`);
      else if (opts.dryRun) log("dry-run: chapter not modified");
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

async function readPreviousBody(bookDir: string, chapterNumber: number): Promise<string> {
  if (chapterNumber <= 1) return "";
  try {
    return (await readChapterMarkdown(bookDir, chapterNumber - 1)).body;
  } catch {
    return "";
  }
}
