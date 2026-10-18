import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logMock = vi.fn();
const logErrorMock = vi.fn();
let projectRoot = "";

vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  findProjectRoot: () => projectRoot,
  log: (message: string) => logMock(message),
  logError: (message: string) => logErrorMock(message),
}));

const NOW = "2026-01-01T00:00:00.000Z";
const FLAGGED = "他随即伫立在原地，眼眸宛如古井。\n\n「你到底想怎样？」她问。\n";

async function setupProject(): Promise<string> {
  projectRoot = await mkdtemp(join(tmpdir(), "inkos-aiflavor-cmd-"));
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
  await mkdir(join(bookDir, "story"), { recursive: true });
  await writeFile(join(bookDir, "book.json"), JSON.stringify({
    id: "demo",
    title: "Demo",
    platform: "other",
    genre: "xuanhuan",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  }), "utf-8");
  await writeFile(join(bookDir, "chapters", "0001_ch.md"), `# 第1章\n\n${FLAGGED}`, "utf-8");
  await writeFile(join(bookDir, "story", "character_matrix.md"), "## 顾晴\n", "utf-8");
  return bookDir;
}

describe("inkos ai-flavor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    process.env.INKOS_AGENT_LLM_STUB = "1";
  });

  afterEach(() => {
    delete process.env.INKOS_AGENT_LLM_STUB;
    process.exitCode = undefined;
  });

  it("scores a chapter without rewriting", async () => {
    await setupProject();
    const { aiFlavorCommand } = await import("../commands/ai-flavor.js");
    await aiFlavorCommand.parseAsync(["node", "ai-flavor", "score", "demo", "--chapter", "1", "--json"], { from: "node" });
    expect(logErrorMock).not.toHaveBeenCalled();
    expect(logMock.mock.calls[0]?.[0]).toContain("deprecated");
    expect(logMock.mock.calls[0]?.[0]).toContain("inkos deai score");
    const payload = JSON.parse(logMock.mock.calls.at(-1)?.[0] as string);
    expect(payload.bookId).toBe("demo");
    expect(payload.chapter).toBe(1);
    expect(payload.metrics.score).toBeGreaterThan(0);
    expect(payload.metrics.flaggedParagraphs).toContain(0);
    expect(payload.skill).toBeTruthy();
  });

  it("dry-run rewrite does not modify the chapter", async () => {
    const bookDir = await setupProject();
    const before = await readFile(join(bookDir, "chapters", "0001_ch.md"), "utf-8");
    const { aiFlavorCommand } = await import("../commands/ai-flavor.js");
    await aiFlavorCommand.parseAsync(
      ["node", "ai-flavor", "rewrite", "demo", "--chapter", "1", "--dry-run", "--json"],
      { from: "node" },
    );
    expect(logErrorMock).not.toHaveBeenCalled();
    expect(logMock.mock.calls[0]?.[0]).toContain("deprecated");
    const payload = JSON.parse(logMock.mock.calls.at(-1)?.[0] as string);
    expect(payload.wroteChapter).toBe(false);
    expect(await readFile(join(bookDir, "chapters", "0001_ch.md"), "utf-8")).toBe(before);
  });

  it("writes --out without touching the chapter file", async () => {
    const bookDir = await setupProject();
    const before = await readFile(join(bookDir, "chapters", "0001_ch.md"), "utf-8");
    const out = join(projectRoot, "rewritten.md");
    const { aiFlavorCommand } = await import("../commands/ai-flavor.js");
    await aiFlavorCommand.parseAsync(
      ["node", "ai-flavor", "rewrite", "demo", "--chapter", "1", "--out", out, "--json"],
      { from: "node" },
    );
    expect(logErrorMock).not.toHaveBeenCalled();
    expect(await readFile(join(bookDir, "chapters", "0001_ch.md"), "utf-8")).toBe(before);
    const written = await readFile(out, "utf-8");
    expect(written.length).toBeGreaterThan(0);
  });
});
