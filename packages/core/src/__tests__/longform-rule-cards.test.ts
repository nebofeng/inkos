import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContinuityAuditor } from "../agents/continuity.js";
import { buildWriterSystemPrompt } from "../agents/writer-prompts.js";
import { ReviserAgent } from "../agents/reviser.js";
import {
  parseRuleCard,
  pickLongformRuleCards,
  type RuleCard,
} from "../rule-cards/index.js";

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

const CARD: RuleCard = parseRuleCard({
  id: "OPEN-001",
  title: "开篇不可预测",
  rule: "前500字不把后文写死",
  check: "开篇是否不可预测？",
  good: "第一句把人扔进现场",
  bad: "从天气写起",
  stage: ["writer", "reviser", "auditor"],
  scope: "opening",
  genre: "all",
  priority: "high",
});

function stubCtx(projectRoot: string) {
  return {
    client: {
      provider: "openai" as const,
      apiFormat: "chat" as const,
      stream: false,
      defaults: {
        temperature: 0.7,
        maxTokens: 4096,
        thinkingBudget: 0,
        extra: {},
      },
    },
    model: "test-model",
    projectRoot,
  };
}

describe("longform rule-card injection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pickLongformRuleCards logs formatRuleCardsLog and skips empty catalogs", () => {
    const info = vi.fn();
    expect(pickLongformRuleCards({
      cards: [],
      stage: "writer",
      chapterNumber: 1,
      logger: { info },
    })).toEqual([]);
    expect(info).not.toHaveBeenCalled();

    const picked = pickLongformRuleCards({
      cards: [CARD],
      stage: "writer",
      chapterNumber: 1,
      genre: "玄幻",
      logger: { info },
    });
    expect(picked.map((item) => item.id)).toEqual(["OPEN-001"]);
    expect(info).toHaveBeenCalledWith(
      "[rule-cards] stage=writer scope=opening genre=玄幻 picked=OPEN-001",
    );
  });

  it("writer prompt places platform text before 【规则卡】", () => {
    const prompt = buildWriterSystemPrompt(
      {
        id: "prompt-book",
        title: "Prompt Book",
        platform: "tomato",
        platformPreset: "fanqie",
        genre: "other",
        status: "active",
        targetChapters: 20,
        chapterWordCount: 3000,
        createdAt: "2026-03-22T00:00:00.000Z",
        updatedAt: "2026-03-22T00:00:00.000Z",
      },
      {
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
      },
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
      [CARD],
    );
    const platformAt = prompt.indexOf("【平台写法");
    const cardsAt = prompt.indexOf("【规则卡】");
    expect(platformAt).toBeGreaterThan(-1);
    expect(cardsAt).toBeGreaterThan(platformAt);
  });

  it("reviser appends 【规则卡】 at the end when there is no platformBlock", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-rule-cards-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });
    const agent = new ReviserAgent(stubCtx(root));
    const chatSpy = vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: "=== FIXED_ISSUES ===\n- ok\n\n=== REVISED_CONTENT ===\n修订后的正文。",
      usage: ZERO_USAGE,
    });

    try {
      await agent.reviseChapter(
        bookDir,
        "原始正文。",
        1,
        [{ severity: "warning", category: "style", description: "x", suggestion: "y" }],
        "rewrite",
        "xuanhuan",
        { ruleCards: [CARD] },
      );
      const withCards = (chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }>)?.[0]?.content ?? "";
      expect(withCards).toContain("【规则卡】");
      expect(withCards).toContain("OPEN-001");

      chatSpy.mockClear();
      await agent.reviseChapter(
        bookDir,
        "原始正文。",
        1,
        [{ severity: "warning", category: "style", description: "x", suggestion: "y" }],
        "rewrite",
        "xuanhuan",
      );
      const withoutCards = (chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }>)?.[0]?.content ?? "";
      expect(withoutCards).not.toContain("【规则卡】");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("auditor injects the checklist and turns failed cards into issues with cardId", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-auditor-rule-cards-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });
    await writeFile(join(storyDir, "current_state.md"), "# State\n", "utf-8");
    await writeFile(join(bookDir, "book.json"), JSON.stringify({
      id: "rule-card-book",
      title: "Rule Card Book",
      genre: "other",
      platform: "tomato",
      chapterWordCount: 3000,
      targetChapters: 20,
      status: "active",
      language: "zh",
      createdAt: "2026-03-23T00:00:00.000Z",
      updatedAt: "2026-03-23T00:00:00.000Z",
    }, null, 2), "utf-8");

    const auditor = new ContinuityAuditor(stubCtx(root));
    const chatSpy = vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        JSON.stringify({
          passed: true,
          issues: [{
            severity: "warning",
            category: "规则卡",
            description: "开篇把后文写死了",
            suggestion: "改开篇",
            cardId: "OPEN-001",
          }],
          summary: "ok",
        }),
        "OPEN-002: 否 | 金手指只旁白介绍",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    try {
      const result = await auditor.auditChapter(bookDir, "正文。", 1, "other", {
        ruleCards: [
          CARD,
          parseRuleCard({
            id: "OPEN-002",
            rule: "金手指要做出来",
            check: "金手指是否当场见效？",
            stage: "auditor",
            scope: "opening",
            genre: "all",
            priority: "high",
          }),
        ],
      });

      const messages = chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }> | undefined;
      const systemPrompt = messages?.[0]?.content ?? "";
      const userPrompt = messages?.[1]?.content ?? "";
      expect(systemPrompt).toContain("【规则卡清单】");
      expect(userPrompt).toContain("【规则卡清单】");
      expect(result.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ cardId: "OPEN-001" }),
        expect.objectContaining({ cardId: "OPEN-002", severity: "warning" }),
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses cardId from audit JSON without requiring it", () => {
    const auditor = new ContinuityAuditor(stubCtx("/tmp/inkos-auditor-cardid"));
    const withId = (auditor as any).parseAuditResult(JSON.stringify({
      passed: false,
      issues: [{
        severity: "warning",
        category: "规则卡",
        description: "开篇可预测",
        suggestion: "改",
        cardId: "OPEN-001",
      }],
      summary: "ok",
    }), "zh");
    expect(withId.issues[0]?.cardId).toBe("OPEN-001");

    const withoutId = (auditor as any).parseAuditResult(JSON.stringify({
      passed: true,
      issues: [{
        severity: "info",
        category: "文风",
        description: "小问题",
        suggestion: "可改可不改",
      }],
      summary: "ok",
    }), "zh");
    expect(withoutId.issues[0]?.cardId).toBeUndefined();
  });
});
