import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDeslop, type DeslopReviser } from "../pipeline/deslop-runner.js";

const ORIGINAL = "他感到愤怒。全场震惊。这一刻他终于明白了力量。";
const CLEANED = "他捏碎茶杯。老陈的烟烫在裤子上。他只是走过去。";

async function seedChapter(root: string): Promise<string> {
  const bookDir = join(root, "book");
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await writeFile(
    join(bookDir, "chapters", "0001_opening.md"),
    `# 第1章 开篇\n\n${ORIGINAL}\n`,
    "utf-8",
  );
  return bookDir;
}

describe("runDeslop", () => {
  it("overwrites the chapter and keeps a .pre-deslop sidecar", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-deslop-ok-"));
    const bookDir = await seedChapter(root);
    const reviser: DeslopReviser = {
      reviseChapter: vi.fn(async () => ({ revisedContent: CLEANED, wordCount: CLEANED.replace(/\s+/g, "").length })),
    };

    const result = await runDeslop({
      bookDir,
      chapterNumber: 1,
      config: { enabled: true, keepOriginal: true, maxRetries: 2 },
      reviser,
    });

    expect(result.status).toBe("ok");
    expect(result.attempts).toBe(1);
    const body = await readFile(join(bookDir, "chapters", "0001_opening.md"), "utf-8");
    expect(body).toContain(CLEANED);
    expect(body).not.toContain("他感到愤怒");
    const sidecar = await readFile(join(bookDir, "chapters", "0001_opening.md.pre-deslop"), "utf-8");
    expect(sidecar).toContain(ORIGINAL);
    expect(reviser.reviseChapter).toHaveBeenCalledOnce();
  });

  it("skips when disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-deslop-skip-"));
    const bookDir = await seedChapter(root);
    const reviser: DeslopReviser = {
      reviseChapter: vi.fn(async () => ({ revisedContent: CLEANED, wordCount: 1 })),
    };

    const result = await runDeslop({
      bookDir,
      chapterNumber: 1,
      config: { enabled: false, keepOriginal: true, maxRetries: 2 },
      reviser,
    });

    expect(result.status).toBe("skipped");
    expect(reviser.reviseChapter).not.toHaveBeenCalled();
    const body = await readFile(join(bookDir, "chapters", "0001_opening.md"), "utf-8");
    expect(body).toContain(ORIGINAL);
  });

  it("retries then marks failed without overwriting", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-deslop-fail-"));
    const bookDir = await seedChapter(root);
    const reviser: DeslopReviser = {
      reviseChapter: vi.fn(async () => {
        throw new Error("model down");
      }),
    };

    const result = await runDeslop({
      bookDir,
      chapterNumber: 1,
      config: { enabled: true, keepOriginal: true, maxRetries: 2 },
      reviser,
    });

    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(2);
    expect(result.error).toContain("model down");
    expect(reviser.reviseChapter).toHaveBeenCalledTimes(2);
    const body = await readFile(join(bookDir, "chapters", "0001_opening.md"), "utf-8");
    expect(body).toContain(ORIGINAL);
  });
});
