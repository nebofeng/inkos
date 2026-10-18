import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DeAIPauseError, isDeAIPauseError, runDeAI } from "../deai/index.js";
import { QualityGatePauseError, isQualityGatePauseError, qualityGateJsonPath } from "../quality-gate/index.js";

const CLEAN = Array.from({ length: 40 }, (_, i) => `「走。」他说。她点头。这是第${i}句对话。`).join("\n");
const BOOKISH = "他随即伫立在原地，眼眸宛如古井，唇角氤氲，心底蔓延涌起，须臾宛如静谧斑驳，俨然难以名状。命运一往无前，他知道这一刻信念。".repeat(4);

async function seedBook(body = BOOKISH): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inkos-deai-"));
  const bookDir = join(root, "book");
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await writeFile(join(bookDir, "chapters", "0001_opening.md"), `# 第1章 开篇\n\n${body}\n`, "utf-8");
  return bookDir;
}

describe("runDeAI", () => {
  it("pass: does not rewrite when score is under threshold", async () => {
    const rewriter = vi.fn(async () => CLEAN);
    const result = await runDeAI({
      bookId: "demo",
      bookDir: "/tmp",
      chapterNumber: 1,
      minWords: 10,
      text: CLEAN,
      persist: false,
      rewriter,
    });
    expect(result.passed).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.rewritten).toBe(false);
    expect(result.content).toBe(CLEAN);
    expect(rewriter).not.toHaveBeenCalled();
  });

  it("rewrite: rewrites until the rescore passes", async () => {
    const rewriter = vi.fn(async () => CLEAN);
    const result = await runDeAI({
      bookId: "demo",
      bookDir: "/tmp",
      chapterNumber: 1,
      minWords: 10,
      text: BOOKISH,
      persist: false,
      rewriter,
      project: { qualityGate: { onFail: "retry", maxRetries: 2, aiFlavorThreshold: 60 } },
    });
    expect(rewriter).toHaveBeenCalledTimes(1);
    expect(result.passed).toBe(true);
    expect(result.rewritten).toBe(true);
    expect(result.content).toBe(CLEAN);
    expect(result.attempts).toBe(1);
  });

  it("warn-keep: keeps the last rewrite when still failing", async () => {
    const rewritten = `${BOOKISH}\n又改了一刀。`;
    const rewriter = vi.fn(async () => rewritten);
    const bookDir = await seedBook(BOOKISH);
    const result = await runDeAI({
      bookId: "demo",
      bookDir,
      chapterNumber: 1,
      minWords: 10,
      text: BOOKISH,
      persist: true,
      rewriter,
      project: { qualityGate: { onFail: "warn", maxRetries: 1, aiFlavorThreshold: 60 }, deslop: { enabled: true, keepOriginal: true } },
    });
    expect(result.passed).toBe(false);
    expect(result.status).toBe("warned");
    expect(result.rewritten).toBe(true);
    expect(result.content).toBe(rewritten);
    expect(result.originalContent).toBe(BOOKISH);
    expect(rewriter).toHaveBeenCalledTimes(1);
    const body = await readFile(join(bookDir, "chapters", "0001_opening.md"), "utf-8");
    expect(body).toContain("又改了一刀");
    const sidecar = await readFile(join(bookDir, "chapters", "0001_opening.md.pre-deslop"), "utf-8");
    expect(sidecar).toContain(BOOKISH.slice(0, 12));
    const gate = JSON.parse(await readFile(qualityGateJsonPath(bookDir), "utf-8")) as {
      chapters: Array<{ passed: boolean; score: number; skipped?: boolean }>;
    };
    expect(gate.chapters).toHaveLength(1);
    expect(gate.chapters[0]?.passed).toBe(false);
    expect(typeof gate.chapters[0]?.score).toBe("number");
    const deai = JSON.parse(await readFile(join(bookDir, "story", "deai.json"), "utf-8")) as {
      chapters: Array<{ status: string; rewritten: boolean }>;
    };
    expect(deai.chapters[0]?.status).toBe("warned");
    expect(deai.chapters[0]?.rewritten).toBe(true);
  });

  it("pause: throws DeAIPauseError compatible with QualityGatePauseError catch sites", async () => {
    const rewriter = vi.fn(async () => BOOKISH);
    const err = await runDeAI({
      bookId: "demo",
      bookDir: "/tmp",
      chapterNumber: 3,
      minWords: 1000,
      text: BOOKISH,
      persist: false,
      rewriter,
      project: { qualityGate: { onFail: "pause", aiFlavorThreshold: 60 } },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(err).toBeInstanceOf(DeAIPauseError);
    expect(err).toBeInstanceOf(QualityGatePauseError);
    expect(isDeAIPauseError(err)).toBe(true);
    expect(isQualityGatePauseError(err)).toBe(true);
  });

  it("score-only: no LLM rewrite, no body change, no pause", async () => {
    const rewriter = vi.fn(async () => CLEAN);
    const bookDir = await seedBook(BOOKISH);
    const result = await runDeAI({
      bookId: "demo",
      bookDir,
      chapterNumber: 1,
      minWords: 10,
      text: BOOKISH,
      persist: true,
      mode: "score-only",
      skipReason: "audit-failed",
      rewriter,
      project: { qualityGate: { onFail: "pause", aiFlavorThreshold: 60 } },
    });
    expect(rewriter).not.toHaveBeenCalled();
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("audit-failed");
    expect(result.rewritten).toBe(false);
    expect(result.content).toBe(BOOKISH);
    expect(result.deaiRecord.status).toBe("skipped");
    expect(result.deaiRecord.skipReason).toBe("audit-failed");
    expect(typeof result.score).toBe("number");
    const body = await readFile(join(bookDir, "chapters", "0001_opening.md"), "utf-8");
    expect(body).toContain(BOOKISH.slice(0, 12));
    expect(body).not.toContain(CLEAN.slice(0, 8));
    const deai = JSON.parse(await readFile(join(bookDir, "story", "deai.json"), "utf-8")) as {
      chapters: Array<{ status: string; skipReason?: string; score: number }>;
    };
    expect(deai.chapters[0]?.status).toBe("skipped");
    expect(deai.chapters[0]?.skipReason).toBe("audit-failed");
    expect(typeof deai.chapters[0]?.score).toBe("number");
  });

  it("abort: respects AbortSignal", async () => {
    const rewriter = vi.fn(async () => CLEAN);
    const signal = AbortSignal.abort(new DOMException("stopped", "AbortError"));
    await expect(runDeAI({
      bookId: "demo",
      bookDir: "/tmp",
      chapterNumber: 1,
      minWords: 10,
      text: BOOKISH,
      persist: false,
      rewriter,
      signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(rewriter).not.toHaveBeenCalled();
  });

  it("externalDetect-off: does not call the external detector by default", async () => {
    const runExternalDetect = vi.fn();
    const rewriter = vi.fn(async () => CLEAN);
    await runDeAI({
      bookId: "demo",
      bookDir: "/tmp",
      chapterNumber: 1,
      minWords: 10,
      text: CLEAN,
      persist: false,
      rewriter,
      runExternalDetect,
    });
    expect(runExternalDetect).not.toHaveBeenCalled();
  });

  it("honours book onFail=retry over project warn (S0 precedence)", async () => {
    const rewriter = vi.fn(async () => CLEAN);
    const result = await runDeAI({
      bookId: "demo",
      bookDir: "/tmp",
      chapterNumber: 1,
      minWords: 10,
      text: BOOKISH,
      persist: false,
      rewriter,
      project: { qualityGate: { onFail: "warn", maxRetries: 1, aiFlavorThreshold: 60 } },
      book: { qualityGate: { onFail: "retry" } },
    });
    expect(rewriter).toHaveBeenCalled();
    expect(result.passed).toBe(true);
    expect(result.content).toBe(CLEAN);
  });

  it("state-degraded score-only records skipReason and score", async () => {
    const rewriter = vi.fn(async () => CLEAN);
    const result = await runDeAI({
      bookId: "demo",
      bookDir: "/tmp",
      chapterNumber: 2,
      minWords: 10,
      text: BOOKISH,
      persist: false,
      mode: "score-only",
      skipReason: "state-degraded",
      rewriter,
      project: { deAI: { enabled: true, onFail: "pause" } },
    });
    expect(rewriter).not.toHaveBeenCalled();
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe("state-degraded");
    expect(result.record.skipped).toBe(true);
    expect(typeof result.record.score).toBe("number");
  });
});
