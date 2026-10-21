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

async function setupProject(opts?: { openingCheckEnabled?: boolean; bookEnabled?: boolean }): Promise<string> {
  projectRoot = await mkdtemp(join(tmpdir(), "inkos-opening-cmd-"));
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
    openingCheck: { enabled: opts?.openingCheckEnabled ?? true },
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
    ...(opts?.bookEnabled === undefined ? {} : { openingCheck: { enabled: opts.bookEnabled } }),
  }), "utf-8");
  await writeFile(
    join(bookDir, "chapters", "0001_ch.md"),
    "# 第1章\n\n陆鸣推开门。顾晴说：“编制呢？”\n",
    "utf-8",
  );
  return bookDir;
}

describe("inkos opening-check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    process.env.INKOS_AGENT_LLM_STUB = "1";
  });

  afterEach(() => {
    delete process.env.INKOS_AGENT_LLM_STUB;
    process.exitCode = undefined;
  });

  it("skips when openingCheck.enabled is false", async () => {
    await setupProject({ openingCheckEnabled: false });
    const { openingCheckCommand } = await import("../commands/opening-check.js");
    await openingCheckCommand.parseAsync(["node", "opening-check", "demo", "--json"], { from: "node" });
    expect(logErrorMock).not.toHaveBeenCalled();
    const payload = JSON.parse(logMock.mock.calls.at(-1)?.[0] as string);
    expect(payload).toMatchObject({ skipped: true, bookId: "demo" });
    expect(payload.reason).toContain("openingCheck.enabled=false");
  });

  it("lets book-level disable override project", async () => {
    await setupProject({ openingCheckEnabled: true, bookEnabled: false });
    const { openingCheckCommand } = await import("../commands/opening-check.js");
    await openingCheckCommand.parseAsync(["node", "opening-check", "demo"], { from: "node" });
    expect(logMock.mock.calls.at(-1)?.[0]).toContain("openingCheck.enabled=false");
  });

  it("writes report files when enabled", async () => {
    const bookDir = await setupProject({ openingCheckEnabled: true });
    const { openingCheckCommand } = await import("../commands/opening-check.js");
    await openingCheckCommand.parseAsync(["node", "opening-check", "demo", "--json"], { from: "node" });
    expect(logErrorMock).not.toHaveBeenCalled();
    const payload = JSON.parse(logMock.mock.calls.at(-1)?.[0] as string);
    expect(payload.bookId).toBe("demo");
    expect(payload.items.filter((item: { id: unknown }) => typeof item.id === "number")).toHaveLength(8);
    expect(payload.hardGate).toBeDefined();
    expect(payload.binding.model).toBe("stub-model");
    const json = JSON.parse(await readFile(join(bookDir, "story", "opening-check.json"), "utf-8"));
    expect(json.bookId).toBe("demo");
    await readFile(join(bookDir, "story", "opening-check.md"), "utf-8");
  });
});
