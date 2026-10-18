import { Command } from "commander";
import {
  createDeAISkill,
  getDeAISkill,
  listDeAISkills,
  validateDeAISkill,
  type DeAISkillListItem,
  type DeAISkillRecord,
} from "@actalk/inkos-core";
import { findProjectRoot, log, logError, resolveBookId } from "../utils.js";

export const deaiCommand = new Command("deai")
  .description("De-AI scoring, rewrite, and custom skills")
  .option("--skill <id>", "Select deAI skill (CLI > book.deAI.skill > project.deAI.skill > default)");

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

function fail(action: string, error: unknown): void {
  logError(`${action} failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
