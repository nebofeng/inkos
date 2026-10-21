import { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  StateManager,
  WRITING_TEMPLATE_FIELD_KEYS,
  WritingTemplateFieldsSchema,
  formatWritingTemplateContext,
  mergeWritingTemplatePatch,
  resolveEffectiveWritingTemplate,
  shouldHardBlockGoldenFinger,
  unsetWritingTemplateFields,
  type WritingTemplateFieldKey,
  type WritingTemplateFields,
} from "@actalk/inkos-core";
import { findProjectRoot, log, logError, resolveBookId } from "../utils.js";

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`Expected boolean, got "${value}"`);
}

function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseFieldKeys(raw: string | undefined): WritingTemplateFieldKey[] {
  if (!raw) {
    throw new Error(`--fields is required (comma-separated: ${WRITING_TEMPLATE_FIELD_KEYS.join(",")})`);
  }
  const keys = raw.split(",").map((item) => item.trim()).filter(Boolean);
  const invalid = keys.filter((key) => !WRITING_TEMPLATE_FIELD_KEYS.includes(key as WritingTemplateFieldKey));
  if (invalid.length > 0) {
    throw new Error(`Unknown fields: ${invalid.join(", ")}. Known: ${WRITING_TEMPLATE_FIELD_KEYS.join(", ")}`);
  }
  return keys as WritingTemplateFieldKey[];
}

function patchFromOpts(opts: {
  proseStyle?: string;
  openingStrategy?: string;
  requireGoldenFinger?: string;
  goldenFingerSoftGate?: string;
  satisfactionTypes?: string;
  skillCardIds?: string;
  structureTemplateId?: string;
  notes?: string;
}): WritingTemplateFields {
  const patch: WritingTemplateFields = {
    proseStyle: opts.proseStyle,
    openingStrategy: opts.openingStrategy,
    requireGoldenFinger: parseBool(opts.requireGoldenFinger),
    goldenFingerSoftGate: parseBool(opts.goldenFingerSoftGate),
    satisfactionTypes: parseList(opts.satisfactionTypes),
    skillCardIds: parseList(opts.skillCardIds),
    structureTemplateId: opts.structureTemplateId,
    notes: opts.notes,
  };
  return WritingTemplateFieldsSchema.parse(
    Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
  );
}

async function loadProjectRaw(root: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(root, "inkos.json"), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function saveProjectRaw(root: string, config: Record<string, unknown>): Promise<void> {
  await writeFile(join(root, "inkos.json"), JSON.stringify(config, null, 2), "utf-8");
}

function readProjectTemplate(config: Record<string, unknown>): WritingTemplateFields | undefined {
  const writing = config.writing;
  if (!writing || typeof writing !== "object") return undefined;
  const template = (writing as { template?: unknown }).template;
  if (!template) return undefined;
  return WritingTemplateFieldsSchema.parse(template);
}

function writeProjectTemplate(
  config: Record<string, unknown>,
  template: WritingTemplateFields | undefined,
): void {
  const writing = (config.writing && typeof config.writing === "object")
    ? { ...(config.writing as Record<string, unknown>) }
    : {};
  if (template) writing.template = template;
  else delete writing.template;
  config.writing = writing;
}

export const writingTemplateCommand = new Command("writing-template")
  .description("Layered writing template (chapter → book → project → default)");

writingTemplateCommand
  .command("show")
  .description("Show effective writing template and per-field sources")
  .option("--book <id>", "Book ID (auto-detected if omitted and a book is needed)")
  .option("--chapter <n>", "Chapter number (optional override layer)")
  .option("--json", "Output JSON")
  .action(async (opts: { book?: string; chapter?: string; json?: boolean }) => {
    try {
      const root = findProjectRoot();
      const projectRaw = await loadProjectRaw(root);
      const projectTemplate = readProjectTemplate(projectRaw);
      const chapterNumber = opts.chapter ? parseInt(opts.chapter, 10) : undefined;
      const needsBook = Boolean(opts.book || chapterNumber);

      let bookTemplate: WritingTemplateFields | undefined;
      let chapterTemplate: WritingTemplateFields | undefined;
      let bookId: string | undefined;

      if (needsBook) {
        bookId = await resolveBookId(opts.book, root);
        const state = new StateManager(root);
        const book = await state.loadBookConfig(bookId);
        bookTemplate = book.writing?.template;
        if (chapterNumber) {
          const index = await state.loadChapterIndex(bookId);
          const entry = index.find((item) => item.number === chapterNumber);
          if (!entry) throw new Error(`Chapter ${chapterNumber} not found in ${bookId}`);
          chapterTemplate = entry.writingTemplate;
        }
      }

      const resolved = resolveEffectiveWritingTemplate({
        chapter: chapterTemplate,
        book: bookTemplate,
        project: projectTemplate,
      });

      if (opts.json) {
        log(JSON.stringify({
          bookId: bookId ?? null,
          chapter: chapterNumber ?? null,
          effective: resolved.effective,
          sources: resolved.sources,
          hardBlockGoldenFinger: shouldHardBlockGoldenFinger(resolved.effective),
          summary: formatWritingTemplateContext(resolved),
        }, null, 2));
        return;
      }

      log(formatWritingTemplateContext(resolved));
      log(`hardBlockGoldenFinger: ${shouldHardBlockGoldenFinger(resolved.effective)}`);
      log("sources:");
      for (const [field, source] of Object.entries(resolved.sources)) {
        const value = resolved.effective[field as WritingTemplateFieldKey];
        log(`  ${field}: ${source}${value === undefined ? " (unset)" : ` = ${JSON.stringify(value)}`}`);
      }
    } catch (error) {
      logError(String(error instanceof Error ? error.message : error));
      process.exit(1);
    }
  });

writingTemplateCommand
  .command("set")
  .description("Set writing template fields on project, book, or chapter")
  .option("--book <id>", "Book ID (omit to set project/global template)")
  .option("--chapter <n>", "Chapter number (requires --book or auto book)")
  .option("--prose-style <text>")
  .option("--opening-strategy <text>")
  .option("--require-golden-finger <bool>")
  .option("--golden-finger-soft-gate <bool>")
  .option("--satisfaction-types <csv>")
  .option("--skill-card-ids <csv>")
  .option("--structure-template-id <id>")
  .option("--notes <text>")
  .option("--json")
  .action(async (opts) => {
    try {
      const patch = patchFromOpts(opts);
      if (Object.keys(patch).length === 0) {
        throw new Error("Provide at least one field to set");
      }
      const root = findProjectRoot();
      const chapterNumber = opts.chapter ? parseInt(opts.chapter, 10) : undefined;

      if (!opts.book && !chapterNumber) {
        const projectRaw = await loadProjectRaw(root);
        const next = mergeWritingTemplatePatch(readProjectTemplate(projectRaw), patch);
        writeProjectTemplate(projectRaw, next);
        await saveProjectRaw(root, projectRaw);
        if (opts.json) log(JSON.stringify({ scope: "project", template: next }, null, 2));
        else log("Updated project writing.template");
        return;
      }

      const bookId = await resolveBookId(opts.book, root);
      const state = new StateManager(root);
      if (chapterNumber) {
        const index = [...await state.loadChapterIndex(bookId)];
        const idx = index.findIndex((item) => item.number === chapterNumber);
        if (idx < 0) throw new Error(`Chapter ${chapterNumber} not found in ${bookId}`);
        const current = index[idx]!;
        const next = mergeWritingTemplatePatch(current.writingTemplate, patch);
        index[idx] = { ...current, writingTemplate: next, updatedAt: new Date().toISOString() };
        await state.saveChapterIndex(bookId, index);
        if (opts.json) log(JSON.stringify({ scope: "chapter", bookId, chapter: chapterNumber, template: next }, null, 2));
        else log(`Updated chapter ${chapterNumber} writingTemplate on ${bookId}`);
        return;
      }

      const book = await state.loadBookConfig(bookId);
      const next = mergeWritingTemplatePatch(book.writing?.template, patch);
      await state.saveBookConfig(bookId, {
        ...book,
        writing: { ...book.writing, template: next },
        updatedAt: new Date().toISOString(),
      });
      if (opts.json) log(JSON.stringify({ scope: "book", bookId, template: next }, null, 2));
      else log(`Updated book writing.template on ${bookId}`);
    } catch (error) {
      logError(String(error instanceof Error ? error.message : error));
      process.exit(1);
    }
  });

writingTemplateCommand
  .command("unset")
  .description("Clear writing template fields so the layer inherits again")
  .option("--book <id>", "Book ID (omit to unset project/global fields)")
  .option("--chapter <n>", "Chapter number")
  .requiredOption("--fields <csv>", `Fields to unset (${WRITING_TEMPLATE_FIELD_KEYS.join(",")})`)
  .option("--json")
  .action(async (opts) => {
    try {
      const keys = parseFieldKeys(opts.fields);
      const root = findProjectRoot();
      const chapterNumber = opts.chapter ? parseInt(opts.chapter, 10) : undefined;

      if (!opts.book && !chapterNumber) {
        const projectRaw = await loadProjectRaw(root);
        const next = unsetWritingTemplateFields(readProjectTemplate(projectRaw), keys);
        writeProjectTemplate(projectRaw, next);
        await saveProjectRaw(root, projectRaw);
        if (opts.json) log(JSON.stringify({ scope: "project", template: next ?? null }, null, 2));
        else log(`Unset project fields: ${keys.join(", ")}`);
        return;
      }

      const bookId = await resolveBookId(opts.book, root);
      const state = new StateManager(root);
      if (chapterNumber) {
        const index = [...await state.loadChapterIndex(bookId)];
        const idx = index.findIndex((item) => item.number === chapterNumber);
        if (idx < 0) throw new Error(`Chapter ${chapterNumber} not found in ${bookId}`);
        const current = index[idx]!;
        const next = unsetWritingTemplateFields(current.writingTemplate, keys);
        const { writingTemplate: _drop, ...rest } = current;
        index[idx] = {
          ...rest,
          ...(next ? { writingTemplate: next } : {}),
          updatedAt: new Date().toISOString(),
        };
        await state.saveChapterIndex(bookId, index);
        if (opts.json) log(JSON.stringify({ scope: "chapter", bookId, chapter: chapterNumber, template: next ?? null }, null, 2));
        else log(`Unset chapter ${chapterNumber} fields: ${keys.join(", ")}`);
        return;
      }

      const book = await state.loadBookConfig(bookId);
      const next = unsetWritingTemplateFields(book.writing?.template, keys);
      const writing = { ...book.writing };
      if (next) writing.template = next;
      else delete writing.template;
      await state.saveBookConfig(bookId, {
        ...book,
        writing: Object.keys(writing).length > 0 ? writing : undefined,
        updatedAt: new Date().toISOString(),
      });
      if (opts.json) log(JSON.stringify({ scope: "book", bookId, template: next ?? null }, null, 2));
      else log(`Unset book fields: ${keys.join(", ")}`);
    } catch (error) {
      logError(String(error instanceof Error ? error.message : error));
      process.exit(1);
    }
  });
