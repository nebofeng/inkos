import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../program.js";

const logMock = vi.fn();
const logErrorMock = vi.fn();
let projectRoot = "";
let previousHome: string | undefined;

vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  findProjectRoot: () => projectRoot,
  log: (message: string) => logMock(message),
  logError: (message: string) => logErrorMock(message),
}));

const NOW = "2026-01-01T00:00:00.000Z";

async function setupProject(): Promise<void> {
  projectRoot = await mkdtemp(join(tmpdir(), "inkos-deai-cmd-"));
  process.env.HOME = join(projectRoot, "home");
  await mkdir(process.env.HOME, { recursive: true });
  await writeFile(join(projectRoot, "inkos.json"), JSON.stringify({
    name: "demo",
    version: "0.1.0",
    llm: {
      provider: "custom",
      service: "custom",
      configSource: "env",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-test",
      model: "stub-model",
    },
  }, null, 2), "utf-8");
  const bookDir = join(projectRoot, "books", "demo");
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await writeFile(join(bookDir, "book.json"), JSON.stringify({
    id: "demo",
    title: "Demo",
    platform: "other",
    genre: "xuanhuan",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  }), "utf-8");
}

describe("inkos deai skill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    previousHome = process.env.HOME;
  });

  afterEach(() => {
    process.exitCode = undefined;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  it("registers deai skill list/show/new/validate and --skill", () => {
    const program = createProgram();
    const deai = program.commands.find((command) => command.name() === "deai");
    expect(deai).toBeDefined();
    expect(deai?.options.some((option) => option.long === "--skill")).toBe(true);
    const skill = deai?.commands.find((command) => command.name() === "skill");
    expect(skill?.commands.map((command) => command.name())).toEqual([
      "list",
      "show",
      "new",
      "validate",
    ]);
  });

  it("lists built-in deAI skills as JSON", async () => {
    await setupProject();
    const { deaiCommand } = await import("../commands/deai.js");
    await deaiCommand.parseAsync(["node", "deai", "skill", "list", "--json"], { from: "node" });
    expect(logErrorMock).not.toHaveBeenCalled();
    const payload = JSON.parse(logMock.mock.calls.at(-1)?.[0] as string) as Array<{ id: string; source: string }>;
    const builtin = payload.filter((row) => row.source === "builtin").map((row) => row.id);
    expect(builtin).toEqual(expect.arrayContaining([
      "inkos-story-deslop",
      "inkos-story-deslop-full",
      "inkos-anti-detect",
    ]));
    expect(builtin).not.toContain("inkos-long-writing");
  });

  it("shows a skill body", async () => {
    await setupProject();
    const { deaiCommand } = await import("../commands/deai.js");
    await deaiCommand.parseAsync(["node", "deai", "skill", "show", "inkos-story-deslop"], { from: "node" });
    expect(logErrorMock).not.toHaveBeenCalled();
    const output = logMock.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain("id: inkos-story-deslop");
    expect(output).toContain("source: builtin");
    expect(output).toContain("Semantic prose cleanup");
  });

  it("creates a project skill with kind: deai and refuses overwrite", async () => {
    await setupProject();
    const { deaiCommand } = await import("../commands/deai.js");
    await deaiCommand.parseAsync(
      ["node", "deai", "skill", "new", "house-deslop", "--from", "inkos-story-deslop"],
      { from: "node" },
    );
    expect(logErrorMock).not.toHaveBeenCalled();
    const path = join(projectRoot, ".agents", "skills", "house-deslop", "SKILL.md");
    expect(logMock.mock.calls.at(-1)?.[0]).toContain(path);
    const markdown = await readFile(path, "utf-8");
    expect(markdown).toContain("kind: deai");
    expect(markdown).toContain("name: house-deslop");

    await deaiCommand.parseAsync(["node", "deai", "skill", "new", "house-deslop"], { from: "node" });
    expect(process.exitCode).toBe(1);
    expect(logErrorMock.mock.calls.at(-1)?.[0]).toMatch(/already exists/);
  });

  it("creates a book-level skill with --book", async () => {
    await setupProject();
    const { deaiCommand } = await import("../commands/deai.js");
    await deaiCommand.parseAsync(
      ["node", "deai", "skill", "new", "book-voice", "--book", "demo"],
      { from: "node" },
    );
    expect(logErrorMock).not.toHaveBeenCalled();
    const markdown = await readFile(
      join(projectRoot, "books", "demo", "skills", "book-voice", "SKILL.md"),
      "utf-8",
    );
    expect(markdown).toContain("kind: deai");
  });

  it("validate exits 1 on invalid skill", async () => {
    await setupProject();
    const skillDir = join(projectRoot, ".agents", "skills", "bad-regex");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), [
      "---",
      "name: bad-regex",
      "description: bad",
      "kind: deai",
      "bannedPatterns:",
      '  - "(unclosed"',
      "---",
      "",
      "body",
      "",
    ].join("\n"), "utf-8");
    const { deaiCommand } = await import("../commands/deai.js");
    await deaiCommand.parseAsync(
      ["node", "deai", "skill", "validate", "bad-regex", "--json"],
      { from: "node" },
    );
    expect(process.exitCode).toBe(1);
    const payload = JSON.parse(logMock.mock.calls.at(-1)?.[0] as string) as {
      valid: boolean;
      errors: Array<{ code: string }>;
    };
    expect(payload.valid).toBe(false);
    expect(payload.errors.some((row) => row.code === "regex")).toBe(true);
  });
});
