import type { Hono } from "hono";
import {
  StateManager,
  WritingTemplateFieldsSchema,
  formatWritingTemplateContext,
  mergeWritingTemplatePatch,
  resolveEffectiveWritingTemplate,
  shouldHardBlockGoldenFinger,
  type WritingTemplateFields,
} from "@actalk/inkos-core";
import { ApiError } from "../errors.js";
import { isSafeBookId } from "../safety.js";

export interface WritingTemplateRouteDeps {
  readonly root: string;
}

function asTemplate(value: unknown): WritingTemplateFields | undefined {
  if (!value) return undefined;
  return WritingTemplateFieldsSchema.parse(value);
}

export function registerWritingTemplateRoutes(app: Hono, deps: WritingTemplateRouteDeps): void {
  app.get("/writing-template", async (c) => {
    const bookId = c.req.query("bookId");
    const chapterRaw = c.req.query("chapter");
    const state = new StateManager(deps.root);
    const project = await state.loadProjectConfig();
    const projectTemplate = asTemplate(
      (project.writing as { template?: unknown } | undefined)?.template,
    );

    let bookTemplate: WritingTemplateFields | undefined;
    let chapterTemplate: WritingTemplateFields | undefined;
    if (bookId) {
      if (!isSafeBookId(bookId)) throw new ApiError(400, "BAD_BOOK_ID", "Invalid bookId");
      const book = await state.loadBookConfig(bookId);
      bookTemplate = book.writing?.template;
      if (chapterRaw) {
        const chapter = Number(chapterRaw);
        const index = await state.loadChapterIndex(bookId);
        chapterTemplate = index.find((item) => item.number === chapter)?.writingTemplate;
      }
    }

    const resolved = resolveEffectiveWritingTemplate({
      chapter: chapterTemplate,
      book: bookTemplate,
      project: projectTemplate,
    });
    return c.json({
      bookId: bookId ?? null,
      chapter: chapterRaw ? Number(chapterRaw) : null,
      stored: {
        project: projectTemplate ?? null,
        book: bookTemplate ?? null,
        chapter: chapterTemplate ?? null,
      },
      effective: resolved.effective,
      sources: resolved.sources,
      hardBlockGoldenFinger: shouldHardBlockGoldenFinger(resolved.effective),
      summary: formatWritingTemplateContext(resolved),
    });
  });

  app.put("/writing-template", async (c) => {
    const body = await c.req.json() as {
      scope?: "project" | "book";
      bookId?: string;
      template?: unknown;
    };
    const patch = WritingTemplateFieldsSchema.parse(body.template ?? {});
    const state = new StateManager(deps.root);

    if (body.scope === "project" || !body.bookId) {
      const project = await state.loadProjectConfig();
      const writing = {
        ...((project.writing && typeof project.writing === "object")
          ? project.writing as Record<string, unknown>
          : {}),
      };
      writing.template = mergeWritingTemplatePatch(asTemplate(writing.template), patch);
      await state.saveProjectConfig({ ...project, writing });
      return c.json({ ok: true, scope: "project", template: writing.template });
    }

    if (!isSafeBookId(body.bookId)) throw new ApiError(400, "BAD_BOOK_ID", "Invalid bookId");
    const book = await state.loadBookConfig(body.bookId);
    const template = mergeWritingTemplatePatch(book.writing?.template, patch);
    await state.saveBookConfig(body.bookId, {
      ...book,
      writing: { ...book.writing, template },
      updatedAt: new Date().toISOString(),
    });
    return c.json({ ok: true, scope: "book", bookId: body.bookId, template });
  });
}
