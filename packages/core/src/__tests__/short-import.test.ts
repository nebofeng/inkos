import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { access } from "node:fs/promises";
import { importShorts } from "../shorts/import.js";
import { listShorts } from "../shorts/catalog.js";

const PHASE2_INPUT = "/root/workspace/rd/rd035/phase2-input/publish/zhihu";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function seedFlat(dir: string, id: string, opts: { posted?: boolean; prefix?: string } = {}): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "zhihu-answer.md"), `${opts.prefix ?? "开头"}\n\n这是一篇测试回答。`.repeat(3), "utf-8");
  await writeFile(join(dir, "zhihu-answer-draft.md"), "草稿", "utf-8");
  await writeFile(join(dir, "outline.md"), "大纲", "utf-8");
  await writeFile(join(dir, "review.md"), "审稿", "utf-8");
  await writeFile(join(dir, "zhihu-answer-meta.json"), JSON.stringify({
    id,
    title: `标题-${id}`,
    title_required_prefix: opts.prefix ?? null,
    zhihu_question: "https://www.zhihu.com/question/1",
    not_posted: !opts.posted,
    posted: Boolean(opts.posted),
  }, null, 2), "utf-8");
  if (opts.posted) {
    await writeFile(join(dir, "posted.json"), JSON.stringify({
      id,
      question_url: "https://www.zhihu.com/question/1",
      answer_url: "https://www.zhihu.com/question/1/answer/2",
      posted_at: "2026-10-14T10:00:00+08:00",
      ok: true,
    }, null, 2), "utf-8");
  }
}

async function seedInkos(dir: string, id: string): Promise<void> {
  await mkdir(join(dir, "final"), { recursive: true });
  await mkdir(join(dir, "outline"), { recursive: true });
  await writeFile(join(dir, "final", "full.md"), "# 长篇十二章\n\n正文", "utf-8");
  await writeFile(join(dir, "zhihu-answer.md"), "废后喝下毒酒前，含泪问我「你会解偏微分方程组吗？」\n\n金殿灯火。", "utf-8");
  await writeFile(join(dir, "zhihu-answer-meta.json"), JSON.stringify({
    id,
    title_required_prefix: "废后喝下毒酒前，含泪问我「你会解偏微分方程组吗？」",
    zhihu_question: "https://www.zhihu.com/question/545020913",
    not_posted: true,
  }, null, 2), "utf-8");
  await writeFile(join(dir, "status.json"), JSON.stringify({
    version: 1,
    kind: "short-fiction",
    id,
    status: "failed",
    stage: "production",
    artifacts: [],
    observations: [],
    error: "404 Model",
    updatedAt: "2026-10-12T17:01:09.957Z",
  }, null, 2), "utf-8");
}

const tmpDirs: string[] = [];
async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "inkos-short-import-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("short import", () => {
  it("imports a flat zhihu layout into pending review", async () => {
    const root = await tmp();
    const from = join(root, "src", "traitor");
    await seedFlat(from, "traitor", { prefix: "大家都骂我是叛徒" });
    const result = await importShorts({ projectRoot: root, from });
    expect(result.imported).toBe(1);
    expect(result.pending).toBe(1);
    expect(result.items[0]?.layout).toBe("flat");
    const dest = join(root, "shorts", "traitor");
    const answer = await readFile(join(dest, "final", "zhihu-answer.md"), "utf-8");
    expect(answer).toContain("大家都骂我是叛徒");
    await expect(readFile(join(dest, "imported", "zhihu-answer-meta.json"), "utf-8")).resolves.toContain("traitor");
    const review = JSON.parse(await readFile(join(dest, "review.json"), "utf-8"));
    expect(review).toMatchObject({ state: "pending", source: "import", finalPath: "final/zhihu-answer.md" });
    const status = JSON.parse(await readFile(join(dest, "status.json"), "utf-8"));
    expect(status.status).toBe("complete");
  });

  it("imports posted flat layout as published", async () => {
    const root = await tmp();
    const from = join(root, "src", "daily-new-id");
    await seedFlat(from, "daily-new-id", { posted: true });
    const result = await importShorts({ projectRoot: root, from });
    expect(result.published).toBe(1);
    const review = JSON.parse(await readFile(join(root, "shorts", "daily-new-id", "review.json"), "utf-8"));
    expect(review.state).toBe("published");
    expect(review.answerUrl).toContain("/answer/");
  });

  it("imports an InkOS run, archives failed status, and points at zhihu-answer.md", async () => {
    const root = await tmp();
    const from = join(root, "src", "zhihu-feihou-pde");
    await seedInkos(from, "zhihu-feihou-pde");
    const result = await importShorts({ projectRoot: root, from });
    expect(result.items[0]?.layout).toBe("inkos");
    const dest = join(root, "shorts", "zhihu-feihou-pde");
    const original = JSON.parse(await readFile(join(dest, "imported", "status.original.json"), "utf-8"));
    expect(original.status).toBe("failed");
    const status = JSON.parse(await readFile(join(dest, "status.json"), "utf-8"));
    expect(status.status).toBe("complete");
    const answer = await readFile(join(dest, "final", "zhihu-answer.md"), "utf-8");
    expect(answer.startsWith("废后喝下毒酒前")).toBe(true);
    const review = JSON.parse(await readFile(join(dest, "review.json"), "utf-8"));
    expect(review.state).toBe("pending");
    expect(review.finalPath).toBe("final/zhihu-answer.md");
  });

  it("skips existing ids unless --force", async () => {
    const root = await tmp();
    const from = join(root, "src", "traitor");
    await seedFlat(from, "traitor");
    await importShorts({ projectRoot: root, from });
    const skipped = await importShorts({ projectRoot: root, from });
    expect(skipped.skipped).toBe(1);
    expect(skipped.items[0]?.action).toBe("skipped");
    const forced = await importShorts({ projectRoot: root, from, force: true });
    expect(forced.items[0]?.action).toBe("overwritten");
  });

  it("dry-run does not write destination files", async () => {
    const root = await tmp();
    const from = join(root, "src", "traitor");
    await seedFlat(from, "traitor");
    const result = await importShorts({ projectRoot: root, from, dryRun: true });
    expect(result.items[0]?.action).toBe("would-import");
    await expect(readFile(join(root, "shorts", "traitor", "review.json"), "utf-8")).rejects.toThrow();
  });
});

describe("phase2-input 9 shorts", () => {
  it("imports 4 published and 5 pending from the phase2-input copy", async () => {
    if (!await exists(PHASE2_INPUT)) return;
    const root = await tmp();
    const result = await importShorts({ projectRoot: root, from: PHASE2_INPUT });
    expect(result.items).toHaveLength(9);
    expect(result.published).toBe(4);
    expect(result.pending).toBe(5);
    const listed = await listShorts(root);
    expect(listed).toHaveLength(9);
    expect(listed.filter((item) => item.reviewState === "published")).toHaveLength(4);
  });
});
