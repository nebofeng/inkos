import { beforeEach, describe, expect, it, vi } from "vitest";

const reviseDraftMock = vi.fn();
const runDeAIMock = vi.fn();
const createLLMClientMock = vi.fn(() => ({ client: "stub" }));
const resolveAgentLLMConfigMock = vi.fn(() => ({ model: "stub-model" }));
const buildPipelineConfigMock = vi.fn();
const loadConfigMock = vi.fn();
const loadBookConfigMock = vi.fn();
const logMock = vi.fn();
const logErrorMock = vi.fn();

vi.mock("@actalk/inkos-core", () => ({
  DEFAULT_REVISE_MODE: "spot-fix",
  ANTI_DETECT_SKILL: "inkos-anti-detect",
  DEAI_REWRITE_AGENT: "deai-rewrite",
  runDeAI: runDeAIMock,
  createLLMClient: createLLMClientMock,
  resolveAgentLLMConfig: resolveAgentLLMConfigMock,
  PipelineRunner: class {
    reviseDraft = reviseDraftMock;
  },
  StateManager: class {
    async loadBookConfig() {
      return loadBookConfigMock();
    }
    bookDir(bookId: string) {
      return `/project/books/${bookId}`;
    }
    async getNextChapterNumber() {
      return 2;
    }
  },
  // Mirrors the real core implementation: book-level overrides project-level,
  // both unset falls back to "strict". The real function is unit-tested in
  // packages/core/src/__tests__/revision-gate.test.ts.
  resolveRevisionGate: (
    book: { writing?: { revisionGate?: "strict" | "lenient" | "always" } },
    projectWriting?: { revisionGate?: "strict" | "lenient" | "always" },
  ) => book.writing?.revisionGate ?? projectWriting?.revisionGate ?? "strict",
}));

vi.mock("../utils.js", () => ({
  loadConfig: loadConfigMock,
  buildPipelineConfig: buildPipelineConfigMock,
  findProjectRoot: vi.fn(() => "/project"),
  resolveBookId: vi.fn(async (bookId?: string) => bookId ?? "auto-book"),
  log: logMock,
  logError: logErrorMock,
}));

describe("inkos revise revision gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reviseDraftMock.mockResolvedValue({
      chapterNumber: 1,
      wordCount: 3000,
      fixedIssues: ["- fixed"],
      applied: true,
      status: "ready-for-review",
    });
    buildPipelineConfigMock.mockReturnValue({});
    runDeAIMock.mockResolvedValue({
      rewritten: true,
      content: "rewritten",
      originalContent: "original",
      wordCount: 1200,
      reasons: ["AI 味分 80"],
      passed: false,
      skipReason: undefined,
    });
  });

  it("passes the book-level revisionGate into the pipeline config", async () => {
    loadBookConfigMock.mockResolvedValue({
      language: "zh",
      writing: { revisionGate: "always" },
    });
    loadConfigMock.mockResolvedValue({
      llm: {},
      writing: { reviewRetries: 1, revisionGate: "strict" },
    });

    const { reviseCommand } = await import("../commands/revise.js");
    await reviseCommand.parseAsync(["node", "revise", "demo-book", "1"], { from: "node" });

    expect(buildPipelineConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      "/project",
      expect.objectContaining({ revisionGate: "always" }),
    );
    expect(reviseDraftMock).toHaveBeenCalledWith("demo-book", 1, "spot-fix");
  });

  it("falls back to the project-level revisionGate when the book does not set one", async () => {
    loadBookConfigMock.mockResolvedValue({ language: "zh" });
    loadConfigMock.mockResolvedValue({
      llm: {},
      writing: { reviewRetries: 1, revisionGate: "lenient" },
    });

    const { reviseCommand } = await import("../commands/revise.js");
    await reviseCommand.parseAsync(["node", "revise", "demo-book", "1"], { from: "node" });

    expect(buildPipelineConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      "/project",
      expect.objectContaining({ revisionGate: "lenient" }),
    );
  });

  it("defaults to strict when neither book nor project sets a revisionGate", async () => {
    loadBookConfigMock.mockResolvedValue({ language: "zh" });
    loadConfigMock.mockResolvedValue({ llm: {}, writing: { reviewRetries: 1 } });

    const { reviseCommand } = await import("../commands/revise.js");
    await reviseCommand.parseAsync(["node", "revise", "demo-book", "1"], { from: "node" });

    expect(buildPipelineConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      "/project",
      expect.objectContaining({ revisionGate: "strict" }),
    );
  });

  it("routes --mode anti-detect through runDeAI with inkos-anti-detect", async () => {
    loadBookConfigMock.mockResolvedValue({ language: "zh", genre: "xuanhuan" });
    loadConfigMock.mockResolvedValue({
      llm: { model: "stub-model" },
      modelOverrides: {},
      writing: { reviewRetries: 1 },
    });

    const { reviseCommand } = await import("../commands/revise.js");
    await reviseCommand.parseAsync(
      ["node", "revise", "demo-book", "1", "--mode", "anti-detect", "--json"],
      { from: "node" },
    );

    expect(reviseDraftMock).not.toHaveBeenCalled();
    expect(runDeAIMock).toHaveBeenCalledWith(expect.objectContaining({
      bookId: "demo-book",
      bookDir: "/project/books/demo-book",
      chapterNumber: 1,
      projectRoot: "/project",
      persist: true,
      genre: "xuanhuan",
      overrides: { skill: "inkos-anti-detect" },
    }));
    const payload = JSON.parse(logMock.mock.calls.at(-1)?.[0] as string);
    expect(payload.applied).toBe(true);
    expect(payload.chapterNumber).toBe(1);
    expect(payload.status).toBe("ready-for-review");
  });
});
