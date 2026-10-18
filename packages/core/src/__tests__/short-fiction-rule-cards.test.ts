import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildShortFictionDraftReviewSystemPrompt,
  buildShortFictionOutlineSystemPrompt,
  buildShortFictionWriterSystemPrompt,
} from "../prompts/short-fiction.js";
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
import { parseRuleCard, type RuleCard } from "../rule-cards/index.js";
import { writeReview, type ReviewFile } from "../shorts/review.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "rule-cards");
const SHORT_YAML = join(FIXTURE_DIR, "cards-short.yaml");
const CH = 12;
const DRAFT_MD = `
=== SHORT_FICTION_TITLE ===
电梯多一层
${Array.from({ length: CH }, (_, i) => `=== CHAPTER ${i + 1} TITLE ===
第${i + 1}章
=== CHAPTER ${i + 1} CONTENT ===
${"深夜的电梯停在不存在的十三层，门开了。".repeat(50)}`).join("\n")}
`;

const CARD: RuleCard = parseRuleCard({
  id: "SHORT-001",
  title: "首句落到事件",
  rule: "第一句就要出事",
  check: "删掉第一句后是否立刻失去抓手？",
  good: "公证处的印章盖下去",
  bad: "夜色如墨",
  stage: ["planner", "writer", "auditor", "reviser"],
  scope: "short",
  genre: "all",
  priority: "high",
});

function ctx(projectRoot: string) {
  return { client: { provider: "openai" } as never, model: "fake", projectRoot };
}
function runtimes(projectRoot: string) {
  const c = ctx(projectRoot);
  return { planner: c, outlineReview: c, writer: c, draftReview: c, revise: c, package: c };
}

function stubDownstream() {
  const draft = parseShortFictionBatchDraft(DRAFT_MD, { expectedChapters: CH });
  vi.spyOn(ShortFictionWriterAgent.prototype, "writeDraft").mockResolvedValue(draft);
  vi.spyOn(ShortFictionDraftReviewerAgent.prototype, "reviewDraft").mockResolvedValue("looks fine");
  vi.spyOn(ShortFictionDraftReviserAgent.prototype, "reviseDraft").mockResolvedValue(draft);
  vi.spyOn(ShortFictionPackagingAgent.prototype, "generatePackage").mockResolvedValue({
    title: "电梯多一层", intro: "钩子", sellingPoints: ["反转"], coverPrompt: "", rawContent: "",
  });
  return draft;
}

describe("short-fiction rule-card prompts", () => {
  it("leaves outline/writer/auditor/reviser prompts unchanged when no cards are supplied", () => {
    expect(buildShortFictionOutlineSystemPrompt("zh")).not.toContain("【规则卡】");
    expect(buildShortFictionWriterSystemPrompt("zh")).not.toContain("【规则卡】");
    expect(buildShortFictionDraftReviewSystemPrompt("zh")).not.toContain("【规则卡清单】");
    expect(buildShortFictionOutlineSystemPrompt("en")).not.toContain("【规则卡】");
    expect(buildShortFictionWriterSystemPrompt("en")).not.toContain("【规则卡】");
    expect(buildShortFictionDraftReviewSystemPrompt("en")).not.toContain("【规则卡清单】");
  });

  it("injects 【规则卡】 into planner/writer and checklist into draft reviewer", () => {
    const outline = buildShortFictionOutlineSystemPrompt("zh", [CARD]);
    const writer = buildShortFictionWriterSystemPrompt("zh", [CARD]);
    const auditor = buildShortFictionDraftReviewSystemPrompt("zh", [CARD]);
    expect(outline).toContain("【规则卡】");
    expect(outline).toContain("SHORT-001");
    expect(writer).toContain("【规则卡】");
    expect(writer).toContain("SHORT-001");
    expect(auditor).toContain("【规则卡清单】");
    expect(auditor).toContain("SHORT-001");
    expect(auditor).toContain("是/否");
  });
});

describe("short-fiction runner rule cards + review gate", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-short-s3-"));
    await mkdir(join(root, "kb", "cards"), { recursive: true });
    await writeFile(join(root, "kb", "cards", "cards-short.yaml"), await readFile(SHORT_YAML, "utf-8"), "utf-8");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("writes rule-cards.json, pending review.json, and logs [rule-cards] scope=short picked=SHORT-", async () => {
    stubDownstream();
    vi.spyOn(ShortFictionOutlineAgent.prototype, "createOutline").mockResolvedValue({
      storyTitle: "电梯多一层", rawContent: "# 电梯多一层\n\n## 12章方案",
    });
    vi.spyOn(ShortFictionOutlineReviewerAgent.prototype, "reviewOutline").mockResolvedValue("可执行");
    vi.spyOn(ShortFictionOutlineReviserAgent.prototype, "reviseOutline").mockResolvedValue({
      storyTitle: "电梯多一层", rawContent: "# 电梯多一层\n\n## 12章方案",
    });
    const progress: string[] = [];
    const info = vi.fn();

    const result = await runShortFictionProduction({
      projectRoot: root,
      direction: "恐怖短篇",
      storyId: "elevator",
      chapterCount: CH,
      charsPerChapter: 1000,
      cover: false,
      runtimes: runtimes(root),
      onProgress: (message) => progress.push(message),
      logger: { info, warn: vi.fn() },
    });

    const snapshot = JSON.parse(await readFile(join(root, "shorts", result.storyId, "rule-cards.json"), "utf-8"));
    expect(snapshot).toMatchObject({ version: 1 });
    expect(snapshot.generatedAt).toBeTruthy();
    expect(snapshot.stages.planner.some((id: string) => id.startsWith("SHORT-"))).toBe(true);
    expect(snapshot.stages.writer.some((id: string) => id.startsWith("SHORT-"))).toBe(true);
    expect(snapshot.stages.auditor.some((id: string) => id.startsWith("SHORT-"))).toBe(true);
    expect(snapshot.stages.reviser.some((id: string) => id.startsWith("SHORT-"))).toBe(true);

    const review = JSON.parse(await readFile(join(root, "shorts", result.storyId, "review.json"), "utf-8"));
    expect(review).toMatchObject({ version: 1, state: "pending", source: "inkos" });

    const logs = [...progress, ...info.mock.calls.map((call) => String(call[0]))];
    expect(logs.some((line) => /\[rule-cards\].*scope=short.*picked=SHORT-/.test(line))).toBe(true);
  });

  it("does not overwrite an existing confirmed review.json on resume", async () => {
    await mkdir(join(root, "shorts", "elevator", "outline"), { recursive: true });
    await writeFile(join(root, "shorts", "elevator", "outline", "v002.md"), "## 既有大纲\n12章完整方案", "utf-8");
    const confirmed: ReviewFile = {
      version: 1,
      state: "confirmed",
      source: "inkos",
      confirmedAt: "2026-10-14T00:00:00.000Z",
      history: [{ from: "pending", to: "confirmed", at: "2026-10-14T00:00:00.000Z", by: "studio-user" }],
    };
    await writeReview(join(root, "shorts", "elevator"), confirmed);
    stubDownstream();

    await runShortFictionProduction({
      projectRoot: root,
      direction: "恐怖短篇",
      storyId: "elevator",
      chapterCount: CH,
      charsPerChapter: 1000,
      cover: false,
      runtimes: runtimes(root),
    });

    const review = JSON.parse(await readFile(join(root, "shorts", "elevator", "review.json"), "utf-8"));
    expect(review.state).toBe("confirmed");
    expect(review.confirmedAt).toBe("2026-10-14T00:00:00.000Z");
  });

  it("warns and ignores autoPublish:true", async () => {
    stubDownstream();
    vi.spyOn(ShortFictionOutlineAgent.prototype, "createOutline").mockResolvedValue({
      storyTitle: "电梯多一层", rawContent: "# 电梯多一层\n\n## 12章方案",
    });
    vi.spyOn(ShortFictionOutlineReviewerAgent.prototype, "reviewOutline").mockResolvedValue("可执行");
    vi.spyOn(ShortFictionOutlineReviserAgent.prototype, "reviseOutline").mockResolvedValue({
      storyTitle: "电梯多一层", rawContent: "# 电梯多一层\n\n## 12章方案",
    });
    const warn = vi.fn();
    const progress: string[] = [];
    const result = await runShortFictionProduction({
      projectRoot: root,
      direction: "恐怖短篇",
      storyId: "elevator",
      chapterCount: CH,
      charsPerChapter: 1000,
      cover: false,
      autoPublish: true,
      runtimes: runtimes(root),
      logger: { info: vi.fn(), warn },
      onProgress: (message) => progress.push(message),
    });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/autoPublish/));
    expect(progress.some((line) => /autoPublish/.test(line))).toBe(true);
    const review = JSON.parse(await readFile(join(root, "shorts", result.storyId, "review.json"), "utf-8"));
    expect(review.state).toBe("pending");
  });
});

describe("agent tools do not expose publish or review-state", () => {
  it("has no tool name containing publish or review-state", async () => {
    const files = [
      join(dirname(fileURLToPath(import.meta.url)), "../agent/agent-tools.ts"),
      join(dirname(fileURLToPath(import.meta.url)), "../agent/film-authoring-tools.ts"),
      join(dirname(fileURLToPath(import.meta.url)), "../agent/forecast-tools.ts"),
      join(dirname(fileURLToPath(import.meta.url)), "../agent/skill-tool.ts"),
    ];
    const names: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf-8");
      for (const match of source.matchAll(/name:\s*"([a-z0-9_]+)"/g)) {
        names.push(match[1]!);
      }
    }
    expect(names.length).toBeGreaterThan(10);
    expect(names.filter((name) => /publish|review-state|review_state/.test(name))).toEqual([]);
  });
});
