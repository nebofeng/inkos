import { describe, expect, it } from "vitest";
import type { BookConfig } from "../models/book.js";
import { BookConfigSchema } from "../models/book.js";
import { ProjectConfigSchema } from "../models/project.js";
import type { GenreProfile } from "../models/genre-profile.js";
import { buildWriterSystemPrompt } from "../agents/writer-prompts.js";
import {
  defaultChapterWords,
  getPlatformPreset,
  listPlatformPresets,
  platformPromptBlock,
  resolveChapterWordCount,
  resolveEffectivePlatformPreset,
  resolvePlatformPreset,
  resolveShortFictionPresetBounds,
} from "../platform-presets/index.js";

const LLM = {
  provider: "anthropic" as const,
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test-key",
  model: "claude-sonnet-4-5-20250514",
};

const BOOK: BookConfig = {
  id: "preset-book",
  title: "Preset Book",
  platform: "tomato",
  genre: "other",
  status: "active",
  targetChapters: 20,
  chapterWordCount: 3000,
  createdAt: "2026-03-22T00:00:00.000Z",
  updatedAt: "2026-03-22T00:00:00.000Z",
};

const GENRE: GenreProfile = {
  id: "other",
  name: "综合",
  language: "zh",
  chapterTypes: ["setup", "conflict"],
  fatigueWords: [],
  numericalSystem: false,
  powerScaling: false,
  eraResearch: false,
  pacingRule: "",
  satisfactionTypes: [],
  auditDimensions: [],
};

describe("platform presets", () => {
  it("lists the six writing presets", () => {
    const ids = listPlatformPresets().map((preset) => preset.id);
    expect(ids).toEqual(["qidian", "fanqie", "jjwxc", "qimao", "zhihu-short", "fanqie-short"]);
  });

  it("resolves jinjiang as an alias of jjwxc", () => {
    expect(getPlatformPreset("jinjiang")).toBeUndefined();
    expect(resolvePlatformPreset("jinjiang")?.id).toBe("jjwxc");
    expect(resolvePlatformPreset("JJWXC")?.id).toBe("jjwxc");
  });

  it("merges book.platformPreset over project.platformPreset", () => {
    expect(resolveEffectivePlatformPreset(
      { platformPreset: "fanqie" },
      { platformPreset: "qidian" },
    )?.id).toBe("fanqie");
    expect(resolveEffectivePlatformPreset(
      {},
      { platformPreset: "qidian" },
    )?.id).toBe("qidian");
    expect(resolveEffectivePlatformPreset(
      { platformPreset: "jinjiang" },
      { platformPreset: "qidian" },
    )?.id).toBe("jjwxc");
    expect(resolveEffectivePlatformPreset({}, {})).toBeUndefined();
  });

  it("returns a non-empty prompt block for every preset", () => {
    for (const preset of listPlatformPresets()) {
      const block = platformPromptBlock(preset.id);
      expect(block.length).toBeGreaterThan(10);
      expect(block).toContain("【平台写法");
    }
    expect(platformPromptBlock("jinjiang")).toContain("晋江");
    expect(platformPromptBlock("unknown")).toBe("");
  });

  it("does not let preset defaults override an explicit chapter word count", () => {
    expect(resolveChapterWordCount(4000, "fanqie")).toBe(4000);
    expect(resolveChapterWordCount(undefined, "fanqie")).toBe(2200);
    expect(resolveChapterWordCount(undefined, "jinjiang")).toBe(3000);
    expect(resolveChapterWordCount(undefined, "missing", 2800)).toBe(2800);
    expect(defaultChapterWords("qidian")).toBe(3500);
    expect(defaultChapterWords("zhihu-short")).toBe(2800);
    expect(defaultChapterWords("fanqie-short")).toBe(20000);
    expect(resolveChapterWordCount(18000, "fanqie-short")).toBe(18000);
  });

  it("uses zhihu-short and fanqie-short chapter/length bounds as short-chain defaults", () => {
    const bounds = resolveShortFictionPresetBounds("zhihu-short", "zh");
    expect(bounds).toEqual({
      shortForm: "answer",
      chapterCount: { default: 1, min: 1, max: 1 },
      charsPerChapter: { default: 2800, min: 2200, max: 3500 },
    });
    expect(resolveShortFictionPresetBounds("fanqie-short", "zh")).toEqual({
      shortForm: "answer",
      chapterCount: { default: 1, min: 1, max: 1 },
      charsPerChapter: { default: 20000, min: 10000, max: 30000 },
    });
    expect(listPlatformPresets().find((preset) => preset.id === "zhihu-short")?.shortForm).toBe("answer");
    expect(listPlatformPresets().find((preset) => preset.id === "fanqie-short")?.shortForm).toBe("answer");
    expect(resolveShortFictionPresetBounds("fanqie", "zh")).toBeUndefined();
    expect(resolveShortFictionPresetBounds("zhihu-short", "en")?.charsPerChapter).toBeUndefined();
    expect(resolveShortFictionPresetBounds("fanqie-short", "en")?.charsPerChapter).toBeUndefined();
  });

  it("keeps book.platform as the publish platform and stores platformPreset separately", () => {
    const book = BookConfigSchema.parse({
      ...BOOK,
      platform: "qidian",
      platformPreset: "fanqie",
    });
    expect(book.platform).toBe("qidian");
    expect(book.platformPreset).toBe("fanqie");
  });

  it("accepts project.platformPreset without touching daemon.qualityGates", () => {
    const project = ProjectConfigSchema.parse({
      name: "demo",
      version: "0.1.0",
      llm: LLM,
      platformPreset: "jjwxc",
    });
    expect(project.platformPreset).toBe("jjwxc");
    expect(project.daemon.qualityGates.maxAuditRetries).toBe(2);
    expect(project.qualityGate.enabled).toBe(true);
  });

  it("appends the platform prompt block in the writer system prompt", () => {
    const withPreset = buildWriterSystemPrompt(
      { ...BOOK, platformPreset: "fanqie" },
      GENRE,
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide",
      undefined,
      4,
      "creative",
      undefined,
      "zh",
      "governed",
    );
    expect(withPreset).toContain("【平台写法：番茄免费阅读】");
    expect(withPreset).toContain("你为tomato平台写作");

    const withoutPreset = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide",
      undefined,
      4,
      "creative",
      undefined,
      "zh",
      "governed",
    );
    expect(withoutPreset).not.toContain("【平台写法");
  });
});
