import { Command } from "commander";
import {
  OPENING_CHECK_AGENT,
  OPENING_CHECK_DISPLAY_ITEMS,
  StateManager,
  chatCompletion,
  createLLMClient,
  hardGateLabel,
  resolveAgentLLMConfig,
  resolveOpeningCheckEnabled,
  resolveOpeningCheckHardGate,
  runOpeningCheck,
} from "@actalk/inkos-core";
import { findProjectRoot, loadConfig, log, logError, resolveBookId } from "../utils.js";

export const openingCheckCommand = new Command("opening-check")
  .description("Review the first three chapters against the opening checklist")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--json", "Output JSON")
  .option("--soft", "Soft gate: still report failures but exit 0")
  .action(async (bookIdArg: string | undefined, opts: { json?: boolean; soft?: boolean }) => {
    try {
      const root = findProjectRoot();
      const config = await loadConfig({ projectRoot: root, requireApiKey: false });
      const bookId = await resolveBookId(bookIdArg, root);
      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);
      const enabled = resolveOpeningCheckEnabled(config.openingCheck, book.openingCheck);
      const bookOpeningCheck = {
        ...book.openingCheck,
        ...(opts.soft ? { hardGate: false } : {}),
      };
      if (!enabled) {
        const skipReason = "开篇检查已关闭（openingCheck.enabled=false）";
        if (opts.json) {
          log(JSON.stringify({ skipped: true, reason: skipReason, bookId, hardGate: { passed: true, mode: "disabled", blocks: [] } }, null, 2));
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
        bookOpeningCheck,
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

      const displayIds = new Set(OPENING_CHECK_DISPLAY_ITEMS.map((item) => String(item.id)));
      if (opts.json) {
        log(JSON.stringify(result.report, null, 2));
      } else {
        const hardGate = result.report.hardGate;
        if (hardGate) {
          const mode = hardGate.mode === "hard" ? "硬闸" : hardGate.mode === "soft" ? "软闸" : "未启用";
          log(`硬挡三项 — ${hardGate.passed ? "通过" : "不通过"}（${mode}）`);
          for (const block of hardGate.blocks) {
            const mark = block.verdict === "pass" ? "通过" : block.verdict === "fail" ? "不通过" : "未核验";
            log(`  ${hardGateLabel(block.id)} — ${mark}`);
          }
          if (hardGate.reason) log(`  ${hardGate.reason}`);
        }
        for (const item of result.report.items) {
          if (!displayIds.has(String(item.id))) continue;
          const mark = item.verdict === "pass" ? "通过" : item.verdict === "fail" ? "不通过" : "未核验";
          log(`${item.id}. ${item.title} — ${mark}`);
          if (item.suggestion) log(`   建议：${item.suggestion}`);
        }
        if (result.mdPath) log(`已写入 ${result.mdPath}`);
      }
      const hard = result.report.hardGate;
      const hardGateOn = resolveOpeningCheckHardGate(config.openingCheck, bookOpeningCheck);
      if (hard && !hard.passed && hardGateOn) {
        process.exitCode = 1;
      }
    } catch (error) {
      logError(`Opening check failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });
