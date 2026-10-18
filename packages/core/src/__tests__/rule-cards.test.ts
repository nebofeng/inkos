import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalizeGenreToken,
  formatRuleCardsLog,
  loadRuleCards,
  parseRuleCard,
  parseRuleCardChecklist,
  renderRuleCardsChecklist,
  renderRuleCardsSection,
  resolveRuleCardScopeLabel,
  resolveRuleCardScopes,
  safeParseRuleCard,
  selectRuleCards,
  type RuleCard,
  type RuleCardPriority,
  type RuleCardScope,
  type RuleCardStage,
} from "../rule-cards/index.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "rule-cards");
const SAMPLE_YAML = join(FIXTURE_DIR, "cards-sample.yaml");
const SHORT_YAML = join(FIXTURE_DIR, "cards-short.yaml");

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inkos-rule-cards-"));
  tmpDirs.push(root);
  return root;
}

async function seedCards(
  files: ReadonlyArray<{ readonly name: string; readonly source: string }>,
  extraDir?: string,
): Promise<{ projectRoot: string; configDir?: string }> {
  const projectRoot = await makeRoot();
  const cardsDir = join(projectRoot, "kb", "cards");
  await mkdir(cardsDir, { recursive: true });
  for (const file of files) {
    await writeFile(join(cardsDir, file.name), await readFile(file.source, "utf-8"), "utf-8");
  }
  if (!extraDir) return { projectRoot };
  const configDir = join(projectRoot, extraDir);
  await mkdir(configDir, { recursive: true });
  return { projectRoot, configDir };
}

function card(partial: {
  readonly id: string;
  readonly rule?: string;
  readonly check?: string;
  readonly title?: string;
  readonly good?: string;
  readonly bad?: string;
  readonly stage?: RuleCardStage | RuleCardStage[];
  readonly scope?: RuleCardScope | RuleCardScope[];
  readonly genre?: string | string[];
  readonly priority?: RuleCardPriority;
}): RuleCard {
  return parseRuleCard({
    id: partial.id,
    title: partial.title,
    rule: partial.rule ?? `${partial.id} rule`,
    check: partial.check ?? `${partial.id} check`,
    good: partial.good,
    bad: partial.bad,
    stage: partial.stage ?? "writer",
    scope: partial.scope ?? "any",
    genre: partial.genre ?? "all",
    priority: partial.priority ?? "high",
  });
}

describe("rule-card schema", () => {
  it("normalizes single-value stage/scope/genre strings into arrays", () => {
    const parsed = parseRuleCard({
      id: "OPEN-001",
      rule: "r",
      check: "c",
      stage: "writer",
      scope: "opening",
      genre: "all",
      priority: "high",
    });
    expect(parsed.stage).toEqual(["writer"]);
    expect(parsed.scope).toEqual(["opening"]);
    expect(parsed.genre).toEqual(["all"]);
  });

  it("rejects unknown stage/scope/priority and missing required fields", () => {
    expect(safeParseRuleCard({ id: "X", rule: "r", check: "c", stage: "editor", scope: "any", genre: "all", priority: "high" }).ok).toBe(false);
    expect(safeParseRuleCard({ id: "X", rule: "r", check: "c", stage: "writer", scope: "late", genre: "all", priority: "high" }).ok).toBe(false);
    expect(safeParseRuleCard({ id: "X", rule: "r", check: "c", stage: "writer", scope: "any", genre: "all", priority: "urgent" }).ok).toBe(false);
    expect(safeParseRuleCard({ rule: "r", check: "c", stage: "writer", scope: "any", genre: "all", priority: "high" }).ok).toBe(false);
  });
});

describe("loadRuleCards", () => {
  it("loads 34 sample cards and 18 short cards from kb/cards", async () => {
    const { projectRoot } = await seedCards([
      { name: "cards-sample.yaml", source: SAMPLE_YAML },
      { name: "cards-short.yaml", source: SHORT_YAML },
    ]);
    const cards = await loadRuleCards({ projectRoot });
    expect(cards).toHaveLength(52);
    expect(cards.filter((item) => item.id.startsWith("SHORT-"))).toHaveLength(18);
    expect(cards.some((item) => item.id === "OPEN-001")).toBe(true);
    expect(cards.some((item) => item.scope.includes("short"))).toBe(true);
  });

  it("returns an empty array when directories are missing", async () => {
    const projectRoot = await makeRoot();
    await expect(loadRuleCards({ projectRoot })).resolves.toEqual([]);
  });

  it("skips bad files and bad cards, keeping valid ones", async () => {
    const projectRoot = await makeRoot();
    const dir = join(projectRoot, "kb", "cards");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "broken.yaml"), ":\n  - not: yaml: [", "utf-8");
    await writeFile(
      join(dir, "mixed.yaml"),
      [
        "- id: GOOD-001",
        "  rule: keep",
        "  check: keep?",
        "  stage: writer",
        "  scope: any",
        "  genre: [all]",
        "  priority: high",
        "- id: BAD-001",
        "  rule: missing fields",
        "  stage: nope",
      ].join("\n"),
      "utf-8",
    );
    const warnings: string[] = [];
    const cards = await loadRuleCards({
      projectRoot,
      logger: { warn: (message) => warnings.push(message) },
    });
    expect(cards.map((item) => item.id)).toEqual(["GOOD-001"]);
    expect(warnings.some((line) => line.includes("broken.yaml"))).toBe(true);
    expect(warnings.some((line) => line.includes("BAD-001"))).toBe(true);
  });

  it("keeps the first duplicate id and warns, then merges configDir after kb/cards", async () => {
    const { projectRoot, configDir } = await seedCards(
      [{ name: "cards-sample.yaml", source: SAMPLE_YAML }],
      "extra-cards",
    );
    await writeFile(
      join(configDir!, "dup.yaml"),
      [
        "- id: OPEN-001",
        "  rule: later copy should be ignored",
        "  check: ignored?",
        "  stage: writer",
        "  scope: any",
        "  genre: [all]",
        "  priority: low",
        "- id: EXTRA-001",
        "  rule: extra",
        "  check: extra?",
        "  stage: writer",
        "  scope: any",
        "  genre: [all]",
        "  priority: high",
      ].join("\n"),
      "utf-8",
    );
    const warnings: string[] = [];
    const cards = await loadRuleCards({
      projectRoot,
      configDir,
      logger: { warn: (message) => warnings.push(message) },
    });
    expect(cards).toHaveLength(35);
    expect(cards.find((item) => item.id === "OPEN-001")?.priority).toBe("high");
    expect(cards.some((item) => item.id === "EXTRA-001")).toBe(true);
    expect(warnings.some((line) => line.includes("OPEN-001"))).toBe(true);
  });
});

describe("selectRuleCards", () => {
  it("uses opening+early+any for chapters 1 and 3, and any after chapter 3 without early word count", async () => {
    const { projectRoot } = await seedCards([{ name: "cards-sample.yaml", source: SAMPLE_YAML }]);
    const cards = await loadRuleCards({ projectRoot });

    expect(resolveRuleCardScopes({ mode: "long", chapterNumber: 1 })).toEqual(["opening", "early", "any"]);
    expect(resolveRuleCardScopes({ mode: "long", chapterNumber: 3 })).toEqual(["opening", "early", "any"]);
    expect(resolveRuleCardScopeLabel({ mode: "long", chapterNumber: 4 })).toBe("any");

    const ch1 = selectRuleCards(cards, { stage: "writer", mode: "long", chapterNumber: 1 });
    const ch3 = selectRuleCards(cards, { stage: "writer", mode: "long", chapterNumber: 3 });
    const ch4 = selectRuleCards(cards, { stage: "writer", mode: "long", chapterNumber: 4 });

    expect(ch1).toHaveLength(10);
    expect(ch3).toHaveLength(10);
    expect(ch1.map((item) => item.id)).toEqual(ch3.map((item) => item.id));
    expect(ch1.every((item) => item.scope.some((scope) => scope === "opening" || scope === "early" || scope === "any"))).toBe(true);
    expect(ch4.every((item) => item.scope.includes("any"))).toBe(true);
    expect(ch4.some((item) => item.scope.includes("opening") && !item.scope.includes("any"))).toBe(false);
  });

  it("keeps early+any below 30000 chars and any at/after 30000 for later chapters", async () => {
    const { projectRoot } = await seedCards([{ name: "cards-sample.yaml", source: SAMPLE_YAML }]);
    const cards = await loadRuleCards({ projectRoot });

    expect(resolveRuleCardScopes({ mode: "long", chapterNumber: 4, totalChars: 29999 })).toEqual(["early", "any"]);
    expect(resolveRuleCardScopes({ mode: "long", chapterNumber: 4, totalChars: 30000 })).toEqual(["any"]);

    const early = selectRuleCards(cards, { stage: "writer", mode: "long", chapterNumber: 4, totalChars: 29999 });
    const later = selectRuleCards(cards, { stage: "writer", mode: "long", chapterNumber: 4, totalChars: 30000 });

    expect(early.some((item) => item.scope.includes("early") && !item.scope.includes("any"))).toBe(true);
    expect(later.every((item) => item.scope.includes("any"))).toBe(true);
    expect(later.some((item) => item.scope.includes("early") && !item.scope.includes("any"))).toBe(false);
  });

  it("maps genre ids to Chinese names and prefers exact hits; unknown ids degrade to all", async () => {
    expect(canonicalizeGenreToken("xuanhuan")).toBe("玄幻");
    expect(canonicalizeGenreToken("chuanyue")).toBe("穿越");
    expect(canonicalizeGenreToken("unknown-genre")).toBe("unknown-genre");

    const { projectRoot } = await seedCards([{ name: "cards-sample.yaml", source: SAMPLE_YAML }]);
    const cards = await loadRuleCards({ projectRoot });

    const xuanhuan = selectRuleCards(cards, {
      stage: "writer",
      mode: "long",
      chapterNumber: 10,
      totalChars: 40000,
      genre: "xuanhuan",
    });
    const unknown = selectRuleCards(cards, {
      stage: "writer",
      mode: "long",
      chapterNumber: 10,
      totalChars: 40000,
      genre: "no-such-genre",
    });

    expect(xuanhuan).toHaveLength(10);
    expect(unknown).toHaveLength(10);
    expect(unknown.every((item) => item.genre.some((token) => canonicalizeGenreToken(token) === "all"))).toBe(true);
    expect(unknown.some((item) => item.id === "COOL-003")).toBe(false);

    const ranked = [
      card({ id: "Z-ALL", priority: "high", genre: "all" }),
      card({ id: "A-ALL", priority: "high", genre: "all" }),
      card({ id: "M-HIT", priority: "high", genre: "玄幻" }),
    ];
    expect(
      selectRuleCards(ranked, {
        stage: "writer",
        mode: "long",
        chapterNumber: 10,
        totalChars: 40000,
        genre: "xuanhuan",
      }).map((item) => item.id),
    ).toEqual(["M-HIT", "A-ALL", "Z-ALL"]);
    expect(
      selectRuleCards(ranked, {
        stage: "writer",
        mode: "long",
        chapterNumber: 10,
        totalChars: 40000,
        genre: "no-such-genre",
      }).map((item) => item.id),
    ).toEqual(["A-ALL", "Z-ALL"]);
  });

  it("truncates to 10 and fills to 5 with high all cards of the same stage when scope is relaxed", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      card({ id: `FILL-${String(index + 1).padStart(3, "0")}`, scope: "any", priority: "high" }),
    );
    const truncated = selectRuleCards(many, { stage: "writer", mode: "long", chapterNumber: 10, totalChars: 40000 });
    expect(truncated.map((item) => item.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `FILL-${String(index + 1).padStart(3, "0")}`),
    );

    const sparse = [
      card({ id: "SHORT-KEEP", scope: "short", priority: "mid" }),
      card({ id: "OPEN-KEEP", scope: "opening", priority: "mid" }),
      card({ id: "EARLY-FILL-A", scope: "early", priority: "high" }),
      card({ id: "EARLY-FILL-B", scope: "early", priority: "high" }),
      card({ id: "EARLY-FILL-C", scope: "early", priority: "high" }),
      card({ id: "EARLY-MID", scope: "early", priority: "mid" }),
      card({ id: "PLANNER-ONLY", stage: "planner", scope: "early", priority: "high" }),
    ];
    const filled = selectRuleCards(sparse, { stage: "writer", mode: "short", min: 5, max: 10 });
    expect(filled.map((item) => item.id)).toEqual([
      "SHORT-KEEP",
      "OPEN-KEEP",
      "EARLY-FILL-A",
      "EARLY-FILL-B",
      "EARLY-FILL-C",
    ]);
  });

  it("in short mode only selects short/opening/any unless filling", async () => {
    const { projectRoot } = await seedCards([
      { name: "cards-sample.yaml", source: SAMPLE_YAML },
      { name: "cards-short.yaml", source: SHORT_YAML },
    ]);
    const cards = await loadRuleCards({ projectRoot });
    const selected = selectRuleCards(cards, { stage: "writer", mode: "short" });

    expect(selected.length).toBeGreaterThanOrEqual(5);
    expect(selected.length).toBeLessThanOrEqual(10);
    expect(selected.some((item) => item.id.startsWith("SHORT-"))).toBe(true);
    expect(
      selected.every((item) => item.scope.some((scope) => scope === "short" || scope === "opening" || scope === "any")),
    ).toBe(true);
    expect(selected.some((item) => item.scope.includes("early") && !item.scope.some((scope) => scope === "short" || scope === "opening" || scope === "any"))).toBe(false);
  });

  it("is deterministic for the same input", async () => {
    const { projectRoot } = await seedCards([{ name: "cards-sample.yaml", source: SAMPLE_YAML }]);
    const cards = await loadRuleCards({ projectRoot });
    const first = selectRuleCards(cards, { stage: "writer", mode: "long", chapterNumber: 1, genre: ["xianxia"] });
    const second = selectRuleCards([...cards].reverse(), { stage: "writer", mode: "long", chapterNumber: 1, genre: "xianxia" });
    expect(first.map((item) => item.id)).toEqual(second.map((item) => item.id));
  });
});

describe("renderRuleCards", () => {
  it("renders a section and truncates each card to 200 chars", () => {
    const long = "字".repeat(180);
    const rendered = renderRuleCardsSection([
      card({
        id: "LONG-001",
        title: "超长卡",
        rule: long,
        good: "好例子也很长所以需要截断",
        bad: "坏例子同样很长",
      }),
    ]);
    expect(rendered.startsWith("【规则卡】\n")).toBe(true);
    const body = rendered.slice("【规则卡】\n".length);
    expect(Array.from(body).length).toBe(200);
    expect(body.includes("LONG-001")).toBe(true);
  });

  it("renders a checklist, parses verdicts with evidence, and formats the log line", () => {
    const cards = [
      card({ id: "OPEN-001", check: "开篇是否不可预测？" }),
      card({ id: "SHORT-002", check: "首段是否抛出冲突？" }),
    ];
    const checklist = renderRuleCardsChecklist(cards);
    expect(checklist).toContain("【规则卡清单】");
    expect(checklist).toContain("OPEN-001");
    expect(checklist).toContain("是/否");

    const parsed = parseRuleCardChecklist(
      [
        "nonsense",
        "- OPEN-001: 是 | 前500字没有把后文写死",
        "SHORT-002：否  首段在写天气",
        "cardId=GOLD-001 pass 金手指当场见效",
        "OPEN-001: 否 | duplicate ignored",
      ].join("\n"),
    );
    expect(parsed).toEqual([
      { cardId: "OPEN-001", pass: true, evidence: "前500字没有把后文写死" },
      { cardId: "SHORT-002", pass: false, evidence: "首段在写天气" },
      { cardId: "GOLD-001", pass: true, evidence: "金手指当场见效" },
    ]);

    expect(
      formatRuleCardsLog({
        stage: "writer",
        scope: "short",
        genre: "all",
        cards: [{ id: "SHORT-001" }, { id: "HOOK-002" }],
      }),
    ).toBe("[rule-cards] stage=writer scope=short genre=all picked=SHORT-001,HOOK-002");
  });
});
