import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_DEAI_PROMPTS, buildLocalRewritePrompt } from "../ai-flavor/rewrite-prompt.js";
import {
  createDeAISkill,
  getDeAISkill,
  listDeAISkills,
  parseDeAISkillMarkdown,
  resolveDeAISkill,
  rewritePromptsForDeAISkill,
  scanDeAISkillBans,
  validateDeAISkill,
} from "../deai/skills.js";
import { DEFAULT_DEAI_SKILL } from "../deai/config.js";

async function seedRoot(): Promise<{
  root: string;
  home: string;
  bookId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "inkos-deai-skills-"));
  const home = join(root, "home");
  const bookId = "demo";
  await mkdir(home, { recursive: true });
  return { root, home, bookId };
}

async function writeSkill(
  dir: string,
  id: string,
  opts: {
    kind?: string | null;
    description?: string;
    body?: string;
    extra?: string;
    bannedPhrases?: string[];
    bannedPatterns?: string[];
    scorer?: string;
  } = {},
): Promise<string> {
  const skillDir = join(dir, id);
  await mkdir(skillDir, { recursive: true });
  const lines = ["---", `name: ${id}`, `description: ${opts.description ?? `${id} skill`}`];
  if (opts.kind !== null && opts.kind !== undefined) lines.push(`kind: ${opts.kind}`);
  if (opts.kind === undefined) lines.push("kind: deai");
  if (opts.scorer) lines.push(`scorer: ${opts.scorer}`);
  if (opts.bannedPhrases) {
    lines.push("bannedPhrases:");
    for (const phrase of opts.bannedPhrases) lines.push(`  - ${phrase}`);
  }
  if (opts.bannedPatterns) {
    lines.push("bannedPatterns:");
    for (const pattern of opts.bannedPatterns) lines.push(`  - ${JSON.stringify(pattern)}`);
  }
  if (opts.extra) lines.push(opts.extra);
  lines.push("---", "", opts.body ?? `${id} rewrite prompt`);
  const path = join(skillDir, "SKILL.md");
  await writeFile(path, `${lines.join("\n")}\n`, "utf-8");
  return path;
}

describe("deAI skills", () => {
  it("resolves book > project > user > builtin for the same id", async () => {
    const { root, home, bookId } = await seedRoot();
    const id = "inkos-story-deslop";
    await writeSkill(join(home, ".agents", "skills"), id, { body: "user prompt" });
    await writeSkill(join(root, ".agents", "skills"), id, { body: "project agents prompt" });
    await writeSkill(join(root, "skills"), id, { body: "project skills prompt" });
    await writeSkill(join(root, "books", bookId, "skills"), id, { body: "book prompt" });

    const listed = await listDeAISkills({ projectRoot: root, bookId, homeDir: home });
    const same = listed.filter((row) => row.id === id);
    expect(same.map((row) => row.source)).toEqual(["book", "project", "project", "user", "builtin"]);
    expect(same[0]?.shadowed).toBe(false);
    expect(same.slice(1).every((row) => row.shadowed)).toBe(true);

    const resolved = await resolveDeAISkill(id, { projectRoot: root, bookId, homeDir: home });
    expect(resolved.skill.source).toBe("book");
    expect(resolved.skill.body).toContain("book prompt");
    expect(resolved.fallback).toBe(false);
  });

  it("falls back to the next location when a higher copy is invalid", async () => {
    const { root, home, bookId } = await seedRoot();
    const id = "house-deslop";
    await writeSkill(join(root, "books", bookId, "skills"), id, {
      bannedPatterns: ["(unclosed"],
      body: "bad book",
    });
    await writeSkill(join(root, ".agents", "skills"), id, { body: "good project" });

    const resolved = await resolveDeAISkill(id, { projectRoot: root, bookId, homeDir: home });
    expect(resolved.skill.source).toBe("project");
    expect(resolved.skill.body).toContain("good project");
    expect(resolved.fallback).toBe(true);
    expect(resolved.warnings.some((row) => row.includes("invalid"))).toBe(true);
  });

  it("rejects custom skills without kind: deai", async () => {
    const { root, home } = await seedRoot();
    const path = await writeSkill(join(root, ".agents", "skills"), "custom-deslop", {
      kind: null,
      body: "no kind",
    });
    const listed = await listDeAISkills({ projectRoot: root, homeDir: home });
    expect(listed.some((row) => row.id === "custom-deslop")).toBe(false);

    const validated = await validateDeAISkill(path, { projectRoot: root, homeDir: home });
    expect(validated.valid).toBe(false);
    expect(validated.errors.some((row) => row.field === "kind")).toBe(true);

    const resolved = await resolveDeAISkill("custom-deslop", { projectRoot: root, homeDir: home });
    expect(resolved.skill.id).toBe(DEFAULT_DEAI_SKILL);
    expect(resolved.skill.source).toBe("builtin");
    expect(resolved.fallback).toBe(true);
  });

  it("treats built-in inkos-story-deslop without kind as deai", async () => {
    const { root, home } = await seedRoot();
    const skill = await getDeAISkill("inkos-story-deslop", { projectRoot: root, homeDir: home });
    expect(skill?.valid).toBe(true);
    expect(skill?.source).toBe("builtin");
    expect(skill?.kind).toBe("deai");
  });

  it("validates regex compile and length cap", async () => {
    const { root, home } = await seedRoot();
    await writeSkill(join(root, "skills"), "regex-bad", {
      bannedPatterns: ["(unclosed", "a".repeat(300)],
    });
    const validated = await validateDeAISkill("regex-bad", { projectRoot: root, homeDir: home });
    expect(validated.valid).toBe(false);
    expect(validated.errors.some((row) => row.code === "regex")).toBe(true);
    expect(validated.errors.some((row) => row.code === "length")).toBe(true);
  });

  it("does not execute user YAML or markdown code", async () => {
    const { root, home } = await seedRoot();
    const marker = `__deai_skill_exec_${Date.now()}`;
    (globalThis as Record<string, unknown>)[marker] = false;
    const skillDir = join(root, ".agents", "skills", "evil-deslop");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), [
      "---",
      "name: evil-deslop",
      "description: should not execute",
      "kind: deai",
      'run: !!js/function "function () { globalThis.' + marker + " = true; }\"",
      "---",
      "",
      "eval('throw new Error(\"executed\")'); process.exit(1);",
      "",
    ].join("\n"), "utf-8");

    const validated = await validateDeAISkill("evil-deslop", { projectRoot: root, homeDir: home });
    expect((globalThis as Record<string, unknown>)[marker]).toBe(false);
    expect(validated.valid).toBe(false);
    expect(validated.errors.some((row) => row.code === "yaml")).toBe(true);
    delete (globalThis as Record<string, unknown>)[marker];
  });

  it("keeps the default-skill local rewrite prompt identical", async () => {
    const { root, home } = await seedRoot();
    const skill = await getDeAISkill(DEFAULT_DEAI_SKILL, { projectRoot: root, homeDir: home });
    expect(skill?.source).toBe("builtin");
    expect(rewritePromptsForDeAISkill({
      id: skill!.id,
      name: skill!.name ?? skill!.id,
      description: skill!.description ?? "",
      body: skill!.body,
      source: "builtin",
      path: skill!.path,
      kind: "deai",
      bannedPhrases: skill!.bannedPhrases,
      bannedPatterns: skill!.bannedPatterns,
      preserve: skill!.preserve,
      scorer: "builtin-ai-flavor",
    })).toBeUndefined();

    const paragraphs = ["他随即伫立在原地，眼眸宛如古井。", "「你到底想怎样？」她问。"];
    const expected = buildLocalRewritePrompt(DEFAULT_DEAI_PROMPTS, paragraphs, [0], ["陆鸣"]);
    const actual = buildLocalRewritePrompt(
      rewritePromptsForDeAISkill({
        id: DEFAULT_DEAI_SKILL,
        name: DEFAULT_DEAI_SKILL,
        description: "x",
        body: skill!.body,
        source: "builtin",
        path: skill!.path,
        kind: "deai",
        bannedPhrases: [],
        bannedPatterns: [],
        preserve: [],
        scorer: "builtin-ai-flavor",
      }) ?? DEFAULT_DEAI_PROMPTS,
      paragraphs,
      [0],
      ["陆鸣"],
    );
    expect(actual).toBe(expected);
    expect(actual).toContain(DEFAULT_DEAI_PROMPTS[0]!);
  });

  it("scans banned phrases/patterns without removing them", async () => {
    const text = "他嘴角微微上扬，然而命运却未改。";
    const issues = scanDeAISkillBans(text, {
      bannedPhrases: ["嘴角微微上扬"],
      bannedPatterns: ["然而.{0,8}却"],
    });
    expect(issues).toEqual([
      "bannedPhrase: 嘴角微微上扬",
      "bannedPattern: 然而.{0,8}却",
    ]);
    expect(text).toContain("嘴角微微上扬");
  });

  it("lists built-in full and anti-detect skills", async () => {
    const { root, home } = await seedRoot();
    const listed = await listDeAISkills({ projectRoot: root, homeDir: home });
    const ids = listed.filter((row) => row.source === "builtin" && !row.shadowed).map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining([
      "inkos-story-deslop",
      "inkos-story-deslop-full",
      "inkos-anti-detect",
    ]));
    expect(ids).not.toContain("inkos-long-writing");
  });

  it("createDeAISkill writes kind: deai and refuses overwrite", async () => {
    const { root, home } = await seedRoot();
    const created = await createDeAISkill("house-voice", {
      from: "inkos-story-deslop",
      scope: "project",
      projectRoot: root,
      homeDir: home,
    });
    expect(created.path).toBe(join(root, ".agents", "skills", "house-voice", "SKILL.md"));
    const parsed = parseDeAISkillMarkdown(
      await (await import("node:fs/promises")).readFile(created.path, "utf-8"),
      { path: created.path, source: "project" },
    );
    expect(parsed.kind).toBe("deai");
    expect(parsed.valid).toBe(true);
    await expect(createDeAISkill("house-voice", {
      scope: "project",
      projectRoot: root,
      homeDir: home,
    })).rejects.toThrow(/already exists/);
  });

  it("ignores unknown frontmatter fields", async () => {
    const parsed = parseDeAISkillMarkdown(
      [
        "---",
        "name: extra-fields",
        "description: ok",
        "kind: deai",
        "unknownWidget: true",
        "nested:",
        "  foo: 1",
        "---",
        "",
        "body text",
      ].join("\n"),
      { path: "/tmp/extra-fields/SKILL.md", source: "project" },
    );
    expect(parsed.valid).toBe(true);
    expect(parsed.body).toContain("body text");
  });

  it("rejects unknown scorers", async () => {
    const parsed = parseDeAISkillMarkdown(
      [
        "---",
        "name: js-scorer",
        "description: no custom js",
        "kind: deai",
        "scorer: ./score.js",
        "---",
        "",
        "x",
      ].join("\n"),
      { path: "/tmp/js-scorer/SKILL.md", source: "project" },
    );
    expect(parsed.valid).toBe(false);
    expect(parsed.errors.some((row) => row.field === "scorer")).toBe(true);
  });
});
