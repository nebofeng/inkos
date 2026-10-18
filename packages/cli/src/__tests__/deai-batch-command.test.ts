import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
const BOOKISH = "他随即伫立在原地，眼眸宛如古井，唇角氤氲，心底蔓延涌起，须臾宛如静谧斑驳，俨然难以名状。命运一往无前，他知道这一刻信念。".repeat(4);

async function setupProject(): Promise<void> {
  projectRoot = await mkdtemp(join(tmpdir(), "inkos-deai-batch-cmd-"));
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
  await writeFile(join(bookDir, "chapters", "0001_opening.md"), `# 第1章 开篇\n\n${BOOKISH}\n`, "utf-8");
  await writeFile(join(bookDir, "chapters", "0002_next.md"), `# 第2章 继续\n\n${BOOKISH}\n`, "utf-8");
}

function lastJson(): Record<string, unknown> {
  const raw = logMock.mock.calls.at(-1)?.[0];
  expect(typeof raw).toBe("string");
  return JSON.parse(String(raw)) as Record<string, unknown>;
}

describe("inkos deai run / deslop", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    previousHome = process.env.HOME;
    await setupProject();
  });

  afterEach(() => {
    process.exitCode = undefined;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  it("registers deslop as an alias of deai run", () => {
    const program = createProgram();
    const deai = program.commands.find((command) => command.name() === "deai");
    const run = deai?.commands.find((command) => command.name() === "run");
    const score = deai?.commands.find((command) => command.name() === "score");
    const rollback = deai?.commands.find((command) => command.name() === "rollback");
    const deslop = program.commands.find((command) => command.name() === "deslop");
    expect(run).toBeDefined();
    expect(score).toBeDefined();
    expect(rollback).toBeDefined();
    expect(deslop).toBeDefined();
    const optionLong = (command: typeof run): string[] =>
      (command?.options ?? []).map((option) => option.long ?? option.short ?? option.attributeName()).sort();
    expect(optionLong(deslop)).toEqual(optionLong(run));
    expect(program.commands.find((command) => command.name() === "ai-flavor")).toBeDefined();
  });

  it("prints --json report with chapter/score/written rows", async () => {
    const { deaiCommand } = await import("../commands/deai.js");
    await deaiCommand.parseAsync(
      ["node", "deai", "score", "--book", "demo", "--range", "1-2", "--json"],
      { from: "node" },
    );
    const report = lastJson();
    expect(report.bookId).toBe("demo");
    expect(report.mode).toBe("score-only");
    expect(report.range).toBe("1-2");
    expect(Array.isArray(report.rows)).toBe(true);
    const rows = report.rows as Array<{
      chapter: number;
      scoreBefore: number | null;
      scoreAfter: number | null;
      written: boolean;
      status: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(expect.objectContaining({
      chapter: 1,
      written: false,
      status: "ok",
    }));
    expect(typeof rows[0]?.scoreBefore).toBe("number");
    expect(typeof rows[0]?.scoreAfter).toBe("number");
    expect(rows[1]?.chapter).toBe(2);
    expect(report.chapters).toEqual(expect.objectContaining({
      "1": expect.objectContaining({ status: "ok", written: false }),
    }));
  });

  it("deslop --score-only --json matches deai run --score-only", async () => {
    const { deaiCommand, deslopCommand } = await import("../commands/deai.js");
    await deaiCommand.parseAsync(
      ["node", "deai", "run", "--book", "demo", "--range", "1", "--score-only", "--json"],
      { from: "node" },
    );
    const fromRun = lastJson();
    logMock.mockClear();
    await deslopCommand.parseAsync(
      ["node", "deslop", "--book", "demo", "--range", "1", "--score-only", "--json"],
      { from: "node" },
    );
    const fromDeslop = lastJson();
    expect(fromDeslop.mode).toBe("score-only");
    expect(fromDeslop.bookId).toBe(fromRun.bookId);
    expect(fromDeslop.range).toBe(fromRun.range);
    expect(fromDeslop.rows).toEqual(fromRun.rows);
  });
});
