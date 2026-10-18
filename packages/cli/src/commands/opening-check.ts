import { Command } from "commander";
import {
  OPENING_CHECK_AGENT,
  StateManager,
  chatCompletion,
  createLLMClient,
  resolveAgentLLMConfig,
  resolveOpeningCheckEnabled,
  runOpeningCheck,
} from "@actalk/inkos-core";
import { findProjectRoot, loadConfig, log, logError, resolveBookId } from "../utils.js";

export const openingCheckCommand = new Command("opening-check")
  .description("Review the first three chapters against the opening checklist")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts: { json?: boolean }) => {
    try {
      const root = findProjectRoot();
      const config = await loadConfig({ projectRoot: root, requireApiKey: false });
      const bookId = await resolveBookId(bookIdArg, root);
      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);
      const enabled = resolveOpeningCheckEnabled(config.openingCheck, book.openingCheck);
      if (!enabled) {
        const skipReason = "开篇检查已关闭（openingCheck.enabled=false）";
        if (opts.json) {
          log(JSON.stringify({ skipped: true, reason: skipReason, bookId }, null, 2));
        } else {
          log(skipReason);
        }
        return;
      }

      const bindingConfig = resolveAgentLLMConfig({
        base: config.llm,
        modelOverrides: config.modelOverrides,
        agentName: OPENING_CHECK_AGENT,
      });
      const client = createLLMClient(bindingConfig);
      const result = await runOpeningCheck({
        bookId,
        bookDir: state.bookDir(bookId),
        projectOpeningCheck: config.openingCheck,
        bookOpeningCheck: book.openingCheck,
        binding: { service: bindingConfig.service, model: bindingConfig.model },
        llm: {
          complete: async ({ system, user }) => {
            const response = await chatCompletion(client, bindingConfig.model, [
              { role: "system", content: system },
              { role: "user", content: user },
            ], { temperature: 0.2 });
            return response.content;
          },
        },
      });

      if (opts.json) {
        log(JSON.stringify(result.report, null, 2));
        return;
      }
      for (const item of result.report.items) {
        const mark = item.verdict === "pass" ? "通过" : item.verdict === "fail" ? "不通过" : "未核验";
        log(`${item.id}. ${item.title} — ${mark}`);
        if (item.suggestion) log(`   建议：${item.suggestion}`);
      }
      if (result.mdPath) log(`已写入 ${result.mdPath}`);
    } catch (error) {
      logError(`Opening check failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });
