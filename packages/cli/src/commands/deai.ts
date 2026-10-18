import { Command } from "commander";
import {
  createDeAISkill,
  createLLMClient,
  DEAI_REWRITE_AGENT,
  getDeAISkill,
  listDeAIBackups,
  listDeAISkills,
  resolveAgentLLMConfig,
  rollbackDeAIBatch,
  runDeAIBatch,
  validateDeAISkill,
  type DeAIBatchMode,
  type DeAIBatchReport,
  type DeAIBatchRow,
  type DeAISkillListItem,
  type DeAISkillRecord,
} from "@actalk/inkos-core";
import { findProjectRoot, loadConfig, log, logError, resolveBookId } from "../utils.js";

export const deaiCommand = new Command("deai")
  .description("De-AI scoring, rewrite, and custom skills")
  .option("--skill <id>", "Select deAI skill (CLI > book.deAI.skill > project.deAI.skill > default)");

addRunOptions(
  deaiCommand
    .command("run")
    .description("Batch de-AI over existing chapters"),
).action(async (opts: RunOpts, command: Command) => {
  await executeRun(opts, command, "deai run");
});

deaiCommand
  .command("score")
  .description("Score existing chapters (alias of deai run --score-only)")
  .requiredOption("--book <id>", "Book id")
  .option("--range <range>", "Chapter range: 1-20, 3,5,9, or all", "all")
  .option("--skill <id>", "deAI skill id")
  .option("--threshold <n>", "AI-flavor threshold (0-100)")
  .option("--force", "Allow paused/dropped books")
  .option("--json", "Output JSON report")
  .action(async (opts: ScoreOpts, command: Command) => {
    await executeRun({ ...opts, scoreOnly: true }, command, "deai score");
  });

deaiCommand
  .command("rollback")
  .description("Restore chapter files from a deAI batch backup")
  .requiredOption("--book <id>", "Book id")
  .option("--from <ts>", "Backup timestamp under chapters/.deai-bak/")
  .option("--json", "Output JSON")
  .action(async (opts: { book: string; from?: string; json?: boolean }) => {
    await executeRollback(opts);
  });

export const deslopCommand = addRunOptions(
  new Command("deslop")
    .description("Alias of inkos deai run"),
).action(async (opts: RunOpts, command: Command) => {
  await executeRun(opts, command, "deslop");
});

const skillCommand = deaiCommand
  .command("skill")
  .description("List, show, create, or validate de-AI skills");

skillCommand
  .command("list")
  .description("List de-AI skills (book > project > user > builtin)")
  .option("--book <id>", "Book id (include books/<id>/skills)")
  .option("--json", "Output JSON")
  .action(async (opts: { book?: string; json?: boolean }) => {
    try {
      const ctx = await skillContext(opts.book);
      const rows = await listDeAISkills(ctx);
      if (opts.json) {
        log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        log("No de-AI skills found.");
        return;
      }
      for (const row of rows) {
        log(formatListRow(row));
      }
    } catch (error) {
      fail("deai skill list", error);
    }
  });

skillCommand
  .command("show")
  .description("Show one de-AI skill")
  .argument("<id>", "Skill id")
  .option("--book <id>", "Book id (include books/<id>/skills)")
  .option("--json", "Output JSON")
  .action(async (id: string, opts: { book?: string; json?: boolean }) => {
    try {
      const ctx = await skillContext(opts.book);
      const skill = await getDeAISkill(id, ctx);
      if (!skill) {
        logError(`Unknown deAI skill: ${id}`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        log(JSON.stringify(skill, null, 2));
        return;
      }
      log(formatShow(skill));
    } catch (error) {
      fail("deai skill show", error);
    }
  });

skillCommand
  .command("new")
  .description("Create a custom de-AI skill (refuses to overwrite)")
  .argument("<id>", "New skill id")
  .option("--from <id>", "Template skill id", "inkos-story-deslop")
  .option("--book <id>", "Write to books/<id>/skills instead of .agents/skills")
  .action(async (id: string, opts: { from?: string; book?: string }) => {
    try {
      const ctx = await skillContext(opts.book);
      const created = await createDeAISkill(id, {
        from: opts.from,
        scope: opts.book ? "book" : "project",
        projectRoot: ctx.projectRoot,
        bookId: ctx.bookId,
        homeDir: ctx.homeDir,
      });
      log(`Wrote ${created.path}`);
    } catch (error) {
      fail("deai skill new", error);
    }
  });

skillCommand
  .command("validate")
  .description("Validate a de-AI skill id or SKILL.md path")
  .argument("[idOrPath]", "Skill id or path (validates all in scope when omitted)")
  .option("--book <id>", "Book id (include books/<id>/skills)")
  .option("--json", "Output JSON")
  .action(async (idOrPath: string | undefined, opts: { book?: string; json?: boolean }) => {
    try {
      const ctx = await skillContext(opts.book);
      if (idOrPath) {
        const result = await validateDeAISkill(idOrPath, ctx);
        if (opts.json) {
          log(JSON.stringify(result, null, 2));
        } else if (result.valid) {
          log(`valid: ${result.skill?.id ?? idOrPath}`);
        } else {
          logError(`invalid: ${result.skill?.id ?? idOrPath}`);
          for (const error of result.errors) {
            logError(formatError(error.code, error.field, error.message));
          }
        }
        if (!result.valid) process.exitCode = 1;
        return;
      }

      const rows = await listDeAISkills(ctx);
      const invalid = rows.filter((row) => !row.valid);
      if (opts.json) {
        log(JSON.stringify({ skills: rows, valid: invalid.length === 0 }, null, 2));
      } else if (invalid.length === 0) {
        log(`valid: ${rows.length} deAI skill(s)`);
      } else {
        logError(`invalid: ${invalid.length}/${rows.length} deAI skill(s)`);
        for (const row of invalid) {
          logError(`${row.id} (${row.source}) ${row.path}`);
          for (const error of row.errors) {
            logError(formatError(error.code, error.field, error.message));
          }
        }
      }
      if (invalid.length > 0) process.exitCode = 1;
    } catch (error) {
      fail("deai skill validate", error);
    }
  });

async function skillContext(bookArg?: string): Promise<{
  projectRoot: string;
  bookId?: string;
  homeDir?: string;
}> {
  const projectRoot = findProjectRoot();
  const bookId = bookArg ? await resolveBookId(bookArg, projectRoot) : undefined;
  return { projectRoot, bookId };
}

function formatListRow(row: DeAISkillListItem): string {
  const flags = [
    row.valid ? "ok" : "invalid",
    row.shadowed ? "shadowed" : undefined,
  ].filter(Boolean).join(",");
  const desc = (row.description ?? "").replace(/\s+/g, " ").slice(0, 80);
  return `${row.id}\t${row.source}\t${flags}\t${desc}`;
}

function formatShow(skill: DeAISkillRecord): string {
  const lines = [
    `id: ${skill.id}`,
    `source: ${skill.source}`,
    `path: ${skill.path}`,
    `valid: ${skill.valid}`,
    skill.kind ? `kind: ${skill.kind}` : undefined,
    skill.scorer ? `scorer: ${skill.scorer}` : undefined,
    skill.description ? `description: ${skill.description}` : undefined,
  ].filter((line): line is string => Boolean(line));
  if (skill.errors.length > 0) {
    lines.push("errors:");
    for (const error of skill.errors) {
      lines.push(`- ${formatError(error.code, error.field, error.message)}`);
    }
  }
  if (skill.body.trim()) {
    lines.push("", skill.body.trimEnd());
  }
  return lines.join("\n");
}

function formatError(code: string, field: string | undefined, message: string): string {
  return field ? `${code} (${field}): ${message}` : `${code}: ${message}`;
}


interface RunOpts {
  book: string;
  range?: string;
  scoreOnly?: boolean;
  dryRun?: boolean;
  write?: boolean;
  skill?: string;
  threshold?: string;
  concurrency?: string;
  maxCostUsd?: string;
  resume?: boolean;
  force?: boolean;
  json?: boolean;
}

type ScoreOpts = Pick<RunOpts, "book" | "range" | "skill" | "threshold" | "force" | "json">;

function addRunOptions(command: Command): Command {
  return command
    .requiredOption("--book <id>", "Book id")
    .option("--range <range>", "Chapter range: 1-20, 3,5,9, or all", "all")
    .option("--score-only", "Score and report; no LLM rewrite")
    .option("--dry-run", "Score + estimate rewrites; no LLM rewrite, no chapter writes")
    .option("--no-write", "Write rewrite to story/deai-preview/ instead of chapters")
    .option("--skill <id>", "deAI skill id")
    .option("--threshold <n>", "AI-flavor threshold (0-100)")
    .option("--concurrency <n>", "Parallel chapters (default 1, max 3)", "1")
    .option("--max-cost-usd <n>", "Stop when estimated cost exceeds this USD amount")
    .option("--resume", "Resume the latest run with the same mode")
    .option("--force", "Allow paused/dropped books")
    .option("--json", "Output JSON report");
}

function resolveBatchMode(opts: RunOpts): DeAIBatchMode {
  const flags: string[] = [];
  if (opts.scoreOnly) flags.push("score-only");
  if (opts.dryRun) flags.push("dry-run");
  if (opts.write === false) flags.push("preview");
  if (flags.length > 1) throw new Error(`Conflicting modes: ${flags.join(", ")}`);
  if (opts.scoreOnly) return "score-only";
  if (opts.dryRun) return "dry-run";
  if (opts.write === false) return "preview";
  return "apply";
}

function parentSkill(command: Command): string | undefined {
  const parent = command.parent;
  if (!parent) return undefined;
  const skill = (parent.opts() as { skill?: string }).skill;
  return skill;
}

async function executeRun(opts: RunOpts, command: Command, action: string): Promise<void> {
  try {
    const root = findProjectRoot();
    const bookId = await resolveBookId(opts.book, root);
    const mode = resolveBatchMode(opts);
    const skill = opts.skill ?? parentSkill(command);
    const threshold = opts.threshold != null ? Number(opts.threshold) : undefined;
    if (threshold != null && (!Number.isFinite(threshold) || threshold < 0 || threshold > 100)) {
      throw new Error(`Invalid threshold: ${opts.threshold}`);
    }
    const concurrency = opts.concurrency != null ? Number(opts.concurrency) : undefined;
    const maxCostUsd = opts.maxCostUsd != null ? Number(opts.maxCostUsd) : undefined;
    if (maxCostUsd != null && (!Number.isFinite(maxCostUsd) || maxCostUsd < 0)) {
      throw new Error(`Invalid --max-cost-usd: ${opts.maxCostUsd}`);
    }
    const needsLlm = mode === "preview" || mode === "apply";
    const config = await loadConfig({ projectRoot: root, requireApiKey: needsLlm });
    const rewriteCtx = needsLlm
      ? (() => {
        const binding = resolveAgentLLMConfig({
          base: config.llm,
          modelOverrides: config.modelOverrides,
          agentName: DEAI_REWRITE_AGENT,
        });
        return {
          client: createLLMClient(binding),
          model: binding.model,
          projectRoot: root,
          bookId,
        };
      })()
      : undefined;
    const report = await runDeAIBatch({
      projectRoot: root,
      bookId,
      range: opts.range ?? "all",
      mode,
      skill,
      threshold,
      concurrency,
      maxCostUsd,
      resume: Boolean(opts.resume),
      force: Boolean(opts.force),
      rewriteCtx,
    });
    printBatchReport(report, Boolean(opts.json));
    if (report.rows.some((row) => row.status === "failed")) process.exitCode = 1;
  } catch (error) {
    fail(action, error);
  }
}

async function executeRollback(opts: { book: string; from?: string; json?: boolean }): Promise<void> {
  try {
    const root = findProjectRoot();
    const bookId = await resolveBookId(opts.book, root);
    if (!opts.from) {
      const backups = await listDeAIBackups({ projectRoot: root, bookId });
      if (opts.json) {
        log(JSON.stringify({ bookId, backups }, null, 2));
        return;
      }
      if (backups.length === 0) {
        log("No deAI backups found.");
        return;
      }
      log("Available deAI backups:");
      for (const ts of backups) log(ts);
      return;
    }
    const result = await rollbackDeAIBatch({ projectRoot: root, bookId, from: opts.from });
    if (opts.json) {
      log(JSON.stringify(result, null, 2));
      return;
    }
    log(`Restored ${result.restored.length} file(s) from ${result.from}`);
    for (const file of result.restored) log(file);
  } catch (error) {
    fail("deai rollback", error);
  }
}

function printBatchReport(report: DeAIBatchReport, json: boolean): void {
  if (json) {
    log(JSON.stringify({
      bookId: report.bookId,
      mode: report.mode,
      range: report.range,
      runId: report.runId,
      ts: report.ts,
      estimatedCostUsd: report.estimatedCostUsd,
      stoppedReason: report.stoppedReason,
      costNote: report.costNote,
      skipped: report.skipped,
      chapters: report.chapters,
      rows: report.rows.map(jsonRow),
    }, null, 2));
    return;
  }
  log(formatBatchTable(report.rows));
  if (report.skipped > 0) log(`skipped ${report.skipped} chapter(s) (resume)`);
  if (report.stoppedReason) log(`stopped: ${report.stoppedReason}`);
}

function jsonRow(row: DeAIBatchRow): {
  chapter: number;
  scoreBefore: number | null;
  scoreAfter: number | null;
  written: boolean;
  status: string;
  error?: string;
} {
  return {
    chapter: row.chapter,
    scoreBefore: row.scoreBefore,
    scoreAfter: row.scoreAfter,
    written: row.written,
    status: row.status,
    ...(row.error ? { error: row.error } : {}),
  };
}

function formatBatchTable(rows: readonly DeAIBatchRow[]): string {
  const header = ["chapter", "score before", "score after", "written"];
  const body = rows.map((row) => [
    String(row.chapter),
    row.scoreBefore == null ? "—" : String(row.scoreBefore),
    row.scoreAfter == null ? "—" : String(row.scoreAfter),
    row.written ? "yes" : "no",
  ]);
  const widths = header.map((title, index) => Math.max(title.length, ...body.map((line) => line[index]!.length)));
  const fmt = (line: string[]): string => line.map((cell, index) => cell.padEnd(widths[index]!)).join("  ");
  return [fmt(header), ...body.map(fmt)].join("\n");
}

function fail(action: string, error: unknown): void {
  logError(`${action} failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
