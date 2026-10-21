import { describe, expect, it } from "vitest";
import { BookConfigSchema } from "../models/book.js";
import { ChapterMetaSchema } from "../models/chapter.js";
import { WritingConfigSchema } from "../models/project.js";
import {
  DEFAULT_WRITING_TEMPLATE,
  formatWritingTemplateContext,
  resolveEffectiveWritingTemplate,
  shouldHardBlockGoldenFinger,
  type WritingTemplateFields,
} from "../models/writing-template.js";

const BOOK_BASE = {
  id: "sifa",
  title: "司法所",
  platform: "tomato" as const,
  genre: "urban",
  status: "active" as const,
  targetChapters: 200,
  chapterWordCount: 3000,
  createdAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
};

describe("resolveEffectiveWritingTemplate", () => {
  it("empty layers fall back to defaults", () => {
    const resolved = resolveEffectiveWritingTemplate({});
    expect(resolved.effective.requireGoldenFinger).toBe(true);
    expect(resolved.effective.goldenFingerSoftGate).toBe(false);
    expect(resolved.effective).toEqual(DEFAULT_WRITING_TEMPLATE);
    expect(resolved.sources.requireGoldenFinger).toBe("default");
    expect(resolved.sources.goldenFingerSoftGate).toBe("default");
    expect(resolved.sources.proseStyle).toBe("default");
  });

  it("book-level fields override project/global", () => {
    const project: WritingTemplateFields = {
      proseStyle: "全局文风",
      openingStrategy: "全局开篇",
      requireGoldenFinger: true,
    };
    const book: WritingTemplateFields = {
      proseStyle: "书级文风",
      goldenFingerSoftGate: true,
    };
    const resolved = resolveEffectiveWritingTemplate({ book, project });
    expect(resolved.effective.proseStyle).toBe("书级文风");
    expect(resolved.sources.proseStyle).toBe("book");
    expect(resolved.effective.openingStrategy).toBe("全局开篇");
    expect(resolved.sources.openingStrategy).toBe("project");
    expect(resolved.effective.goldenFingerSoftGate).toBe(true);
    expect(resolved.sources.goldenFingerSoftGate).toBe("book");
    expect(resolved.effective.requireGoldenFinger).toBe(true);
    expect(resolved.sources.requireGoldenFinger).toBe("project");
  });

  it("chapter-level fields override book without mutating the book object", () => {
    const book: WritingTemplateFields = {
      proseStyle: "书级文风",
      openingStrategy: "书级开篇",
      requireGoldenFinger: true,
    };
    const frozenBook = Object.freeze({ ...book });
    const bookSnapshot = JSON.stringify(frozenBook);
    const chapter: WritingTemplateFields = {
      proseStyle: "本章文风",
      skillCardIds: ["card-a"],
    };

    const resolved = resolveEffectiveWritingTemplate({ chapter, book: frozenBook });
    expect(resolved.effective.proseStyle).toBe("本章文风");
    expect(resolved.sources.proseStyle).toBe("chapter");
    expect(resolved.effective.openingStrategy).toBe("书级开篇");
    expect(resolved.sources.openingStrategy).toBe("book");
    expect(resolved.effective.skillCardIds).toEqual(["card-a"]);
    expect(resolved.sources.skillCardIds).toBe("chapter");
    expect(JSON.stringify(frozenBook)).toBe(bookSnapshot);
    expect(frozenBook.proseStyle).toBe("书级文风");
  });

  it("司法所: 现实 procedural + goldenFingerSoftGate=true is a soft gate", () => {
    const resolved = resolveEffectiveWritingTemplate({
      book: {
        proseStyle: "现实 procedural",
        goldenFingerSoftGate: true,
      },
    });
    expect(resolved.effective.proseStyle).toBe("现实 procedural");
    expect(resolved.effective.goldenFingerSoftGate).toBe(true);
    expect(shouldHardBlockGoldenFinger(resolved.effective)).toBe(false);
    expect(formatWritingTemplateContext(resolved)).toContain("goldenFinger=required-soft");
    expect(formatWritingTemplateContext(resolved)).toContain("proseStyle=现实 procedural");
  });

  it("仙族: openingStrategy 账本金手指前移", () => {
    const resolved = resolveEffectiveWritingTemplate({
      book: {
        openingStrategy: "账本金手指前移",
      },
    });
    expect(resolved.effective.openingStrategy).toBe("账本金手指前移");
    expect(resolved.sources.openingStrategy).toBe("book");
    expect(formatWritingTemplateContext(resolved)).toContain("openingStrategy=账本金手指前移");
  });
});

describe("shouldHardBlockGoldenFinger", () => {
  it.each([
    [{ requireGoldenFinger: true, goldenFingerSoftGate: false }, true],
    [{ requireGoldenFinger: true, goldenFingerSoftGate: undefined }, true],
    [{ requireGoldenFinger: true, goldenFingerSoftGate: true }, false],
    [{ requireGoldenFinger: false, goldenFingerSoftGate: false }, false],
    [{ requireGoldenFinger: false, goldenFingerSoftGate: true }, false],
    [{}, false],
  ] as const)("effective=%j → %s", (effective, expected) => {
    expect(shouldHardBlockGoldenFinger(effective)).toBe(expected);
  });
});

describe("formatWritingTemplateContext", () => {
  it("always emits the [writing-template] marker", () => {
    const resolved = resolveEffectiveWritingTemplate({});
    expect(formatWritingTemplateContext(resolved)).toMatch(/^\[writing-template\] /);
    expect(formatWritingTemplateContext(resolved)).toContain("goldenFinger=required-hard");
  });
});

describe("schema persistence", () => {
  it("parses book.writing.template and chapter.writingTemplate", () => {
    const book = BookConfigSchema.parse({
      ...BOOK_BASE,
      writing: {
        template: {
          proseStyle: "现实 procedural",
          goldenFingerSoftGate: true,
        },
      },
    });
    expect(book.writing?.template?.proseStyle).toBe("现实 procedural");

    const chapter = ChapterMetaSchema.parse({
      number: 3,
      title: "临时换模板",
      status: "drafted",
      wordCount: 100,
      createdAt: "2026-10-21T00:00:00.000Z",
      updatedAt: "2026-10-21T00:00:00.000Z",
      writingTemplate: { proseStyle: "本章覆盖" },
    });
    expect(chapter.writingTemplate?.proseStyle).toBe("本章覆盖");

    const writing = WritingConfigSchema.parse({
      template: { openingStrategy: "账本金手指前移" },
    });
    expect(writing.template?.openingStrategy).toBe("账本金手指前移");
  });
});
