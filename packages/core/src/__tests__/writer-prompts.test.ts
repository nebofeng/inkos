import { describe, expect, it } from "vitest";
import type { BookConfig } from "../models/book.js";
import type { GenreProfile } from "../models/genre-profile.js";
import { LengthSpecSchema } from "../models/length-governance.js";
import { buildWriterSystemPrompt, buildGoldenOpeningDiscipline } from "../agents/writer-prompts.js";
import { BookRulesSchema } from "../models/book-rules.js";
import { parseRuleCard } from "../rule-cards/index.js";

const BOOK: BookConfig = {
  id: "prompt-book",
  title: "Prompt Book",
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

describe("buildWriterSystemPrompt", () => {
  it("keeps governed inputs and leaves reusable craft to the activated Skill", () => {
    const prompt = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide\n\nKeep the prose restrained.",
      undefined,
      3,
      "creative",
      undefined,
      "zh",
      "governed",
    );

    expect(prompt).toContain("## 输入治理契约");
    expect(prompt).toContain("卷纲是默认规划");
    expect(prompt).not.toContain("## 核心规则");
    expect(prompt).not.toContain("## 创作宪法");
    expect(prompt).not.toContain("## 代入感六支柱");
  });

  it("enforces narrative person only when the user explicitly set one (#290)", () => {
    const firstPerson = BookRulesSchema.parse({ narrativePerson: "first" });
    const promptFirst = buildWriterSystemPrompt(
      BOOK, GENRE, firstPerson, "# Book Rules", "# Genre Body", "# Style Guide",
      undefined, 3, "creative", undefined, "zh", "governed",
    );
    expect(promptFirst).toContain("叙事人称（硬约束）");
    expect(promptFirst).toContain("第一人称");

    // Unset → no narrative-person section is imposed (the genre default applies).
    const noPerson = BookRulesSchema.parse({});
    const promptNone = buildWriterSystemPrompt(
      BOOK, GENRE, noPerson, "# Book Rules", "# Genre Body", "# Style Guide",
      undefined, 3, "creative", undefined, "zh", "governed",
    );
    expect(promptNone).not.toContain("叙事人称（硬约束）");
  });

  it("injects [writing-template] summary from book.writing.template", () => {
    const prompt = buildWriterSystemPrompt(
      {
        ...BOOK,
        writing: {
          template: {
            proseStyle: "现实 procedural",
            openingStrategy: "账本金手指前移",
            goldenFingerSoftGate: true,
          },
        },
      },
      GENRE,
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide",
      undefined,
      1,
      "creative",
      undefined,
      "zh",
      "governed",
    );
    expect(prompt).toContain("[writing-template]");
    expect(prompt).toContain("proseStyle=现实 procedural");
    expect(prompt).toContain("openingStrategy=账本金手指前移");
    expect(prompt).toContain("goldenFinger=required-soft");
  });

  it("tolerates a stray narrativePerson value (degrades to no constraint, fail-open)", () => {
    const rules = BookRulesSchema.parse({ narrativePerson: "(仅当用户指定)" });
    expect(rules.narrativePerson).toBeUndefined();
  });

  it("uses target-range wording when a length spec is provided", () => {
    const lengthSpec = LengthSpecSchema.parse({
      target: 2200,
      softMin: 1900,
      softMax: 2500,
      hardMin: 1600,
      hardMax: 2800,
      countingMode: "zh_chars",
    });

    const prompt = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide\n\nKeep the prose restrained.",
      undefined,
      3,
      "creative",
      undefined,
      "zh",
      "governed",
      lengthSpec,
    );

    expect(prompt).toContain("目标字数：2200");
    expect(prompt).toContain("允许区间：1900-2500");
    expect(prompt).not.toContain("正文不少于2200字");
  });

  it("keeps hard guardrails and book/style constraints in governed mode", () => {
    const prompt = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      null,
      "# Book Rules\n\n- Do not reveal the mastermind.",
      "# Genre Body",
      "# Style Guide\n\nKeep the prose restrained.",
      undefined,
      3,
      "creative",
      undefined,
      "zh",
      "governed",
    );

    expect(prompt).toContain("Do not reveal the mastermind");
    expect(prompt).toContain("Keep the prose restrained");
  });

  it("injects golden opening discipline into zh writer system prompt for ch<=3", () => {
    for (const ch of [1, 2, 3]) {
      const prompt = buildWriterSystemPrompt(
        BOOK,
        GENRE,
        null,
        "# Book Rules",
        "# Genre Body",
        "# Style Guide",
        undefined,
        ch,
        "creative",
        undefined,
        "zh",
        "governed",
      );
      expect(prompt).toContain("黄金三章写作纪律");
      expect(prompt).toContain(`第 ${ch} 章`);
    }
  });

  it("injects golden opening discipline into en writer system prompt for ch<=3", () => {
    for (const ch of [1, 2, 3]) {
      const prompt = buildWriterSystemPrompt(
        BOOK,
        { ...GENRE, language: "en", name: "General" },
        null,
        "# Book Rules",
        "# Genre Body",
        "# Style Guide",
        undefined,
        ch,
        "creative",
        undefined,
        "en",
        "governed",
      );
      expect(prompt).toContain("Golden Opening Discipline");
      expect(prompt).toContain(`Chapter ${ch}`);
    }
  });

  it("omits golden opening discipline for ch>=4 in both languages", () => {
    const zh = buildWriterSystemPrompt(
      BOOK, GENRE, null, "# Book Rules", "# Genre Body", "# Style Guide",
      undefined, 4, "creative", undefined, "zh", "governed",
    );
    expect(zh).not.toContain("黄金三章写作纪律");

    const en = buildWriterSystemPrompt(
      BOOK, { ...GENRE, language: "en", name: "General" }, null,
      "# Book Rules", "# Genre Body", "# Style Guide",
      undefined, 4, "creative", undefined, "en", "governed",
    );
    expect(en).not.toContain("Golden Opening Discipline");
  });

  it("renders golden opening discipline as cohesive prose, not a checklist", () => {
    const out = buildGoldenOpeningDiscipline(1, "zh");
    // Header line is allowed; body must not contain enumerated/bulleted lines.
    expect(out).not.toMatch(/^\s*1\.\s/m);
    expect(out).not.toMatch(/^\s*-\s/m);
    expect(out).not.toMatch(/^\s*\*\s/m);
    // Carries the load-bearing slot constraints.
    expect(out).toContain("800 字");
    expect(out).toContain("做出来");
    expect(out).toContain("说出来");
    expect(out).toContain("小钩子");
  });

  it("buildGoldenOpeningDiscipline returns empty string for ch>=4 / undefined", () => {
    expect(buildGoldenOpeningDiscipline(4, "zh")).toBe("");
    expect(buildGoldenOpeningDiscipline(99, "en")).toBe("");
    expect(buildGoldenOpeningDiscipline(undefined, "zh")).toBe("");
  });

  it("tells governed English prompts to obey variance briefs and include resistance-bearing exchanges", () => {
    const prompt = buildWriterSystemPrompt(
      {
        ...BOOK,
        language: "en",
      },
      {
        ...GENRE,
        language: "en",
        name: "General",
      },
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide\n\nKeep the prose restrained.",
      undefined,
      3,
      "creative",
      undefined,
      "en",
      "governed",
    );

    expect(prompt).toContain("English Variance Brief");
    expect(prompt).toContain("resistance-bearing exchange");
  });

  it("inserts 【规则卡】 after the platform block and leaves empty cards unchanged", () => {
    const card = parseRuleCard({
      id: "OPEN-001",
      title: "开篇不可预测",
      rule: "前500字不把后文写死",
      check: "开篇是否不可预测？",
      good: "第一句把人扔进现场",
      bad: "从天气写起",
      stage: "writer",
      scope: "opening",
      genre: "all",
      priority: "high",
    });
    const withCards = buildWriterSystemPrompt(
      { ...BOOK, platformPreset: "fanqie" },
      GENRE,
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide",
      undefined,
      1,
      "creative",
      undefined,
      "zh",
      "governed",
      undefined,
      [card],
    );
    const platformAt = withCards.indexOf("【平台写法");
    const cardsAt = withCards.indexOf("【规则卡】");
    expect(platformAt).toBeGreaterThan(-1);
    expect(cardsAt).toBeGreaterThan(platformAt);
    expect(withCards).toContain("OPEN-001");

    const baseline = buildWriterSystemPrompt(
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
    const emptyCards = buildWriterSystemPrompt(
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
      undefined,
      [],
    );
    expect(emptyCards).toBe(baseline);
    expect(emptyCards).not.toContain("【规则卡】");
  });
});
