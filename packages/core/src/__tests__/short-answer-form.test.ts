import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ShortFictionDraftReviewerAgent,
  ShortFictionDraftReviserAgent,
  ShortFictionOutlineAgent,
  ShortFictionOutlineReviewerAgent,
  ShortFictionOutlineReviserAgent,
  ShortFictionPackagingAgent,
  ShortFictionWriterAgent,
  parseShortFictionBatchDraft,
} from "../agents/short-fiction.js";
import { runShortFictionProduction } from "../pipeline/short-fiction-runner.js";
import { resolveShortFictionPresetBounds } from "../platform-presets/index.js";
import { resolveShortRunLength } from "../shorts/bounds.js";
import {
  answerHasChapterMarkers,
  answerStartsWithPrefix,
  buildAnswerQualityObservations,
} from "../shorts/quality.js";
import { buildShortFictionWriterSystemPrompt } from "../prompts/short-fiction.js";
import { parseRuleCard } from "../rule-cards/index.js";

const PREFIX = "将军，愿降否？";
const ANSWER_BODY = `${PREFIX}\n\n${"殿上没人敢先出声。我把腰牌扣在案上，血还是热的。".repeat(80)}`;

function answerDraftMarkdown(): string {
  return `
=== SHORT_FICTION_TITLE ===
将军愿降否
=== CHAPTER 1 TITLE ===
回答
=== CHAPTER 1 CONTENT ===
${ANSWER_BODY}
`;
}

function ctx(projectRoot: string) {
  return { client: { provider: "openai" } as never, model: "fake", projectRoot };
}
function runtimes(projectRoot: string) {
  const c = ctx(projectRoot);
  return { planner: c, outlineReview: c, writer: c, draftReview: c, revise: c, package: c };
}

function stubAnswerAgents() {
  const draft = parseShortFictionBatchDraft(answerDraftMarkdown(), { expectedChapters: 1 });
  vi.spyOn(ShortFictionOutlineAgent.prototype, "createOutline").mockResolvedValue({
    storyTitle: "将军愿降否", rawContent: "# 将军愿降否\n\n单篇回答",
  });
  vi.spyOn(ShortFictionOutlineReviewerAgent.prototype, "reviewOutline").mockResolvedValue("可执行");
  vi.spyOn(ShortFictionOutlineReviserAgent.prototype, "reviseOutline").mockResolvedValue({
    storyTitle: "将军愿降否", rawContent: "# 将军愿降否\n\n单篇回答",
  });
  vi.spyOn(ShortFictionWriterAgent.prototype, "writeDraft").mockResolvedValue(draft);
  vi.spyOn(ShortFictionDraftReviewerAgent.prototype, "reviewDraft").mockResolvedValue("looks fine");
  vi.spyOn(ShortFictionDraftReviserAgent.prototype, "reviseDraft").mockResolvedValue(draft);
  vi.spyOn(ShortFictionPackagingAgent.prototype, "generatePackage").mockResolvedValue({
    title: "将军愿降否", intro: "钩子", sellingPoints: ["反转"], coverPrompt: "", rawContent: "",
  });
  return draft;
}

describe("zhihu-short answer form bounds", () => {
  it("uses preset whole-piece 2200-3500 and 1 segment", () => {
    expect(resolveShortFictionPresetBounds("zhihu-short", "zh")).toMatchObject({
      shortForm: "answer",
      chapterCount: { default: 1, min: 1, max: 1 },
      charsPerChapter: { default: 2800, min: 2200, max: 3500 },
    });
    const resolved = resolveShortRunLength({ platformPreset: "zhihu-short", language: "zh" });
    expect(resolved.shortForm).toBe("answer");
    expect(resolved.chapterCount).toBe(1);
    expect(resolved.targetChars).toBe(2800);
    expect(resolved.minChars).toBe(2200);
    expect(resolved.maxChars).toBe(3500);
  });

  it("applies per-run totalChars / minChars / maxChars overrides", () => {
    const resolved = resolveShortRunLength({
      platformPreset: "zhihu-short",
      language: "zh",
      totalChars: 2500,
      minChars: 2400,
      maxChars: 2600,
    });
    expect(resolved.charsPerChapter).toBe(2500);
    expect(resolved.minChars).toBe(2400);
    expect(resolved.maxChars).toBe(2600);
  });

  it("rejects a default short length against zhihu-short bounds", () => {
    expect(() => resolveShortRunLength({
      platformPreset: "zhihu-short",
      language: "zh",
      charsPerChapter: 1000,
    })).toThrow(/2200-3500/);
  });
});

describe("answer quality checks", () => {
  it("flags missing prefix and chapter markers", () => {
    expect(answerStartsWithPrefix(ANSWER_BODY, PREFIX)).toBe(true);
    expect(answerStartsWithPrefix("别的开头\n", PREFIX)).toBe(false);
    expect(answerHasChapterMarkers("正文\n")).toBe(false);
    expect(answerHasChapterMarkers("## 第1章 开篇\n正文")).toBe(true);
    const observations = buildAnswerQualityObservations({
      markdown: "## 第1章 开篇\n正文",
      language: "zh",
      shortForm: "answer",
      titleRequiredPrefix: PREFIX,
      targetChars: 2800,
      minChars: 2200,
      maxChars: 3500,
    });
    expect(observations.find((item) => item.metric === "required-prefix")?.actual).toBe("missing");
    expect(observations.find((item) => item.metric === "no-chapter-markers")?.actual).toBe("found");
  });
});

describe("short prompts inject platformPromptBlock before rule cards", () => {
  it("places 平台写法 before 【规则卡】", () => {
    const card = parseRuleCard({
      id: "SHORT-001",
      rule: "第一句就要出事",
      check: "删掉第一句后是否立刻失去抓手？",
      good: "公证处的印章盖下去",
      bad: "夜色如墨",
      stage: "writer",
      scope: "short",
      genre: "all",
      priority: "high",
    });
    const prompt = buildShortFictionWriterSystemPrompt("zh", [card], { platformPreset: "zhihu-short", shortForm: "answer" });
    const platformAt = prompt.indexOf("【平台写法");
    const cardsAt = prompt.indexOf("【规则卡】");
    expect(platformAt).toBeGreaterThan(-1);
    expect(cardsAt).toBeGreaterThan(platformAt);
    expect(prompt).toContain("单篇知乎回答");
  });
});

describe("zhihu-short runner artifacts + runDeAI", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-short-s4-"));
    await mkdir(join(root, "kb", "cards"), { recursive: true });
    await writeFile(join(root, "kb", "cards", "empty.yaml"), "[]\n", "utf-8");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("writes zhihu-answer.md, prefix observation, deai.json and calls runDeAI", async () => {
    stubAnswerAgents();
    const rewriter = vi.fn(async ({ text }: { text: string }) => text);
    const result = await runShortFictionProduction({
      projectRoot: root,
      direction: "知乎短篇 将军愿降",
      storyId: "general-surrender",
      platformPreset: "zhihu-short",
      titleRequiredPrefix: PREFIX,
      zhihuQuestion: "https://www.zhihu.com/question/1",
      cover: false,
      deAIRewriter: rewriter,
      runtimes: runtimes(root),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(result.zhihuAnswerPath).toBe("shorts/general-surrender/final/zhihu-answer.md");
    const answer = await readFile(join(root, "shorts", "general-surrender", "final", "zhihu-answer.md"), "utf-8");
    const full = await readFile(join(root, "shorts", "general-surrender", "final", "full.md"), "utf-8");
    expect(answer).toBe(full);
    expect(answer.startsWith(PREFIX)).toBe(true);
    expect(answer).not.toMatch(/第\s*1\s*章/);

    const snapshot = JSON.parse(await readFile(join(root, "shorts", "general-surrender", "status.json"), "utf-8"));
    const metrics = snapshot.observations.map((item: { metric: string }) => item.metric);
    expect(metrics).toEqual(expect.arrayContaining(["final-length", "required-prefix", "no-chapter-markers"]));
    expect(snapshot.observations.find((item: { metric: string }) => item.metric === "required-prefix").actual).toBe("ok");

    const review = JSON.parse(await readFile(join(root, "shorts", "general-surrender", "review.json"), "utf-8"));
    expect(review).toMatchObject({
      state: "pending",
      finalPath: "final/zhihu-answer.md",
      titleRequiredPrefix: PREFIX,
    });

    const deai = JSON.parse(await readFile(join(root, "shorts", "general-surrender", "deai.json"), "utf-8"));
    expect(deai.bookId).toBe("general-surrender");
    expect(deai.chapters).toHaveLength(1);
    expect(deai.chapters[0].chapterNumber).toBe(1);
    await expect(readFile(join(root, "shorts", "general-surrender", "story", "deai.json"), "utf-8")).rejects.toThrow();
  });
});
