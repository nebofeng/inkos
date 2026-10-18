import { Command } from "commander";
import {
  ANTI_DETECT_SKILL,
  DEAI_REWRITE_AGENT,
  DEFAULT_REVISE_MODE,
  PipelineRunner,
  StateManager,
  createLLMClient,
  resolveAgentLLMConfig,
  resolveRevisionGate,
  runDeAI,
  type ProjectConfig,
  type ReviseMode,
  type ReviseResult,
} from "@actalk/inkos-core";
import { loadConfig, buildPipelineConfig, findProjectRoot, resolveBookId, log, logError } from "../utils.js";
import {
  formatNotifyCommandTitle,
  formatNotifyFailureBody,
  formatNotifyReviseBody,
  resolveCliLanguage,
  type CliLanguage,
} from "../localization.js";
import { sendCommandNotification } from "../notify-helper.js";

export const reviseCommand = new Command("revise")
  .description("Revise a chapter based on audit issues")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .argument("[chapter]", "Chapter number (defaults to latest)")
  .option("--mode <mode>", "Revise mode: spot-fix, polish, rewrite, rework, anti-detect", DEFAULT_REVISE_MODE)
  .option("--brief <text>", "One-off creative guidance for this revise/rewrite only")
  .option("--json", "Output JSON")
  .option("--notify", "Send a notification to configured notify channels when the command finishes")
  .action(async (bookIdArg: string | undefined, chapterStr: string | undefined, opts) => {
    let notifyLanguage: CliLanguage = "zh";
    let notifyBookName: string | undefined;
    try {
      const config = await loadConfig();
      const root = findProjectRoot();

      let bookId: string;
      let chapterNumber: number | undefined;
      if (bookIdArg && /^\d+$/.test(bookIdArg)) {
        bookId = await resolveBookId(undefined, root);
        chapterNumber = parseInt(bookIdArg, 10);
      } else {
        bookId = await resolveBookId(bookIdArg, root);
        chapterNumber = chapterStr ? parseInt(chapterStr, 10) : undefined;
      }

      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);
      const language = resolveCliLanguage(book.language);
      notifyLanguage = language;
      notifyBookName = book.title ?? bookId;
      const pipeline = new PipelineRunner(buildPipelineConfig(config, root, {
        externalContext: opts.brief,
        revisionGate: resolveRevisionGate(book, config.writing),
      }));

      const mode = opts.mode as ReviseMode;
      if (!opts.json) log(`Revising "${bookId}"${chapterNumber ? ` chapter ${chapterNumber}` : " (latest)"} [mode: ${mode}]...`);

      const result = mode === "anti-detect"
        ? await runAntiDetectRevise({
            config,
            root,
            bookId,
            genre: book.genre,
            chapterNumber,
          })
        : await pipeline.reviseDraft(bookId, chapterNumber, mode);

      if (opts.json) {
        log(JSON.stringify(result, null, 2));
      } else if (!result.applied) {
        log(`  Chapter ${result.chapterNumber}: kept original draft`);
        if (result.skippedReason) log(`  Reason: ${result.skippedReason}`);
      } else {
        log(`  Chapter ${result.chapterNumber} revised`);
        log(`  Words: ${result.wordCount}`);
        log(`  Status: ${result.status}`);
        log("  Fixed:");
        for (const fix of result.fixedIssues) {
          log(`    - ${fix}`);
        }
      }

      // Unlike write commands, the pipeline sends no notification for
      // reviseDraft, so --notify always sends the completion notification here.
      if (opts.notify) {
        await sendCommandNotification({
          title: formatNotifyCommandTitle(language, "revise", notifyBookName, true),
          body: formatNotifyReviseBody(language, {
            chapterNumber: result.chapterNumber,
            applied: result.applied,
            wordCount: result.wordCount,
            fixedCount: result.fixedIssues.length,
            skippedReason: result.skippedReason,
          }),
        }, config);
      }
    } catch (e) {
      if (opts.notify) {
        await sendCommandNotification({
          title: formatNotifyCommandTitle(notifyLanguage, "revise", notifyBookName, false),
          body: formatNotifyFailureBody(notifyLanguage, e),
        });
      }
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Revise failed: ${e}`);
      }
      process.exit(1);
    }
  });

async function runAntiDetectRevise(input: {
  readonly config: ProjectConfig;
  readonly root: string;
  readonly bookId: string;
  readonly genre?: string;
  readonly chapterNumber?: number;
}): Promise<ReviseResult> {
  const state = new StateManager(input.root);
  const targetChapter = input.chapterNumber ?? (await state.getNextChapterNumber(input.bookId)) - 1;
  if (targetChapter < 1) {
    throw new Error(`No chapters to revise for "${input.bookId}"`);
  }
  const binding = resolveAgentLLMConfig({
    base: input.config.llm,
    modelOverrides: input.config.modelOverrides,
    agentName: DEAI_REWRITE_AGENT,
  });
  const result = await runDeAI({
    bookId: input.bookId,
    bookDir: state.bookDir(input.bookId),
    chapterNumber: targetChapter,
    projectRoot: input.root,
    persist: true,
    genre: input.genre,
    overrides: { skill: ANTI_DETECT_SKILL },
    rewriteCtx: {
      client: createLLMClient(binding),
      model: binding.model,
      projectRoot: input.root,
      bookId: input.bookId,
    },
  });
  const applied = result.rewritten && result.content !== result.originalContent;
  return {
    chapterNumber: targetChapter,
    wordCount: result.wordCount,
    fixedIssues: [...result.reasons],
    applied,
    status: applied ? "ready-for-review" : "unchanged",
    skippedReason: applied
      ? undefined
      : (result.skipReason ?? (result.passed ? "Already under AI-flavor threshold." : undefined)),
  };
}
