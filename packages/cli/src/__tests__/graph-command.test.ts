import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logMock = vi.fn();
const logErrorMock = vi.fn();
let projectRoot = "";

vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  findProjectRoot: () => projectRoot,
  log: (message: string) => logMock(message),
  logError: (message: string) => logErrorMock(message),
}));

// Synthetic placeholder book (no real novel text).
async function setupBook(): Promise<string> {
  projectRoot = await mkdtemp(join(tmpdir(), "inkos-graph-cmd-"));
  const bookDir = join(projectRoot, "books", "gbook");
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await mkdir(join(bookDir, "story"), { recursive: true });
  await writeFile(join(bookDir, "book.json"), JSON.stringify({ id: "gbook", title: "gbook", language: "zh" }), "utf-8");
  await writeFile(join(bookDir, "story", "character_matrix.md"), [
    "## 林砚", "- **定位**: 主角", "- **关系**: 周岚(搭档/Ch1)", "",
    "## 周岚", "- **定位**: 账房", "",
  ].join("\n"), "utf-8");
  const chapters = [
    "林砚推开门。\n林砚和周岚对视。“账本不在这里。”林砚说。\n",
    "周岚说：“那就去码头找。”林砚点头。\n林砚和周岚出发。\n",
    "林砚独自回来。周岚留在码头。\n林砚和周岚通了电话。\n",
  ];
  for (const [index, body] of chapters.entries()) {
    await writeFile(join(bookDir, "chapters", `000${index + 1}_占位${index + 1}.md`), `# 第${index + 1}章 占位${index + 1}\n\n${body}`, "utf-8");
  }
  return bookDir;
}

const lastJson = () => JSON.parse(logMock.mock.calls.at(-1)?.[0] as string);

describe("inkos graph", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("backfills offline with the heuristic extractor, then reports status", async () => {
    const bookDir = await setupBook();
    const { graphCommand } = await import("../commands/graph.js");

    await graphCommand.parseAsync(["node", "graph", "backfill", "gbook", "--extractor", "heuristic", "--json"], { from: "node" });
    expect(logErrorMock).not.toHaveBeenCalled();
    expect(lastJson()).toMatchObject({ bookId: "gbook", extractor: "heuristic:v1", extracted: [1, 2, 3], failed: [] });
    expect((await readdir(join(bookDir, "story", "graph"))).sort()).toEqual([
      "chapter-0001.json", "chapter-0002.json", "chapter-0003.json",
    ]);

    await graphCommand.parseAsync(["node", "graph", "status", "gbook", "--json"], { from: "node" });
    expect(lastJson()).toMatchObject({ enabled: false, chapterFiles: 3, extracted: [1, 2, 3], missing: [], stale: [] });

    await graphCommand.parseAsync(["node", "graph", "rebuild", "gbook", "--chapter", "2", "--extractor", "heuristic", "--json"], { from: "node" });
    expect(lastJson()).toMatchObject({ chapter: 2, extracted: [2] });
  });

  it("runs the offline eval on a copy and leaves the book untouched", async () => {
    const bookDir = await setupBook();
    const { graphCommand } = await import("../commands/graph.js");
    await graphCommand.parseAsync(["node", "graph", "eval", "gbook", "--json"], { from: "node" });
    expect(logErrorMock).not.toHaveBeenCalled();
    const result = lastJson();
    expect(result.chapters).toBe(2);
    expect(result.summary.contradictionsInContext).toBe(0);
    expect(await readdir(join(bookDir, "story"))).not.toContain("graph");
  });
});
