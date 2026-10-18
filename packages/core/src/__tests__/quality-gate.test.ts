import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProjectConfigSchema } from "../models/project.js";
import {
  QualityGatePauseError,
  evaluateQualityGate,
  qualityGateJsonPath,
  resolveQualityGateConfig,
  runQualityGate,
} from "../quality-gate/index.js";

const LLM = {
  provider: "anthropic" as const,
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test-key",
  model: "claude-sonnet-4-5-20250514",
};

const CLEAN = Array.from({ length: 40 }, (_, i) => `「走。」他说。她点头。这是第${i}句对话。`).join("\n");
const BOOKISH = "他随即伫立在原地，眼眸宛如古井，唇角氤氲，心底蔓延涌起，须臾宛如静谧斑驳，俨然难以名状。命运一往无前，他知道这一刻信念。".repeat(4);

describe("evaluateQualityGate", () => {
  it("fails when AI-flavor score meets the threshold", () => {
    const result = evaluateQualityGate({
      text: BOOKISH,
      minWords: 1,
      aiFlavorThreshold: 60,
    });
    expect(result.passed).toBe(false);
    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.reasons.some((reason) => reason.includes("AI 味分"))).toBe(true);
  });

  it("fails when word count is below minWords * minWordRatio", () => {
    const result = evaluateQualityGate({
      text: "短。",
      minWords: 1000,
      aiFlavorThreshold: 100,
      minWordRatio: 0.7,
    });
    expect(result.passed).toBe(false);
    expect(result.wordCount).toBeLessThan(700);
    expect(result.reasons.some((reason) => reason.includes("字数只有目标的"))).toBe(true);
  });

  it("passes clean text that meets the word floor", () => {
    const result = evaluateQualityGate({
      text: CLEAN,
      minWords: 10,
      aiFlavorThreshold: 60,
    });
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });
});

describe("resolveQualityGateConfig", () => {
  it("merges explicit threshold over platformPreset default over 60", () => {
    expect(resolveQualityGateConfig(undefined, undefined, undefined).aiFlavorThreshold).toBe(60);
    expect(resolveQualityGateConfig(undefined, undefined, "zhihu-short").aiFlavorThreshold).toBe(55);
    expect(resolveQualityGateConfig({ aiFlavorThreshold: 80 }, undefined, "zhihu-short").aiFlavorThreshold).toBe(80);
    expect(resolveQualityGateConfig(
      { aiFlavorThreshold: 80 },
      { aiFlavorThreshold: 40 },
      "zhihu-short",
    ).aiFlavorThreshold).toBe(40);
  });

  it("lets book-level enabled/onFail override the project", () => {
    const resolved = resolveQualityGateConfig(
      { enabled: true, onFail: "retry", maxRetries: 2 },
      { enabled: false, onFail: "pause" },
      "qidian",
    );
    expect(resolved.enabled).toBe(false);
    expect(resolved.onFail).toBe("pause");
    expect(resolved.maxRetries).toBe(2);
    expect(resolved.aiFlavorThreshold).toBe(60);
  });
});

describe("runQualityGate", () => {
  it("skips when qualityGate.enabled is false", async () => {
    const rewrite = vi.fn();
    const result = await runQualityGate({
      bookId: "demo",
      bookDir: "/tmp",
      chapterNumber: 1,
      minWords: 1000,
      config: { enabled: false },
      text: "短。",
      persist: false,
      rewrite,
    });
    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true);
    expect(rewrite).not.toHaveBeenCalled();
  });

  it("retries up to maxRetries then warns", async () => {
    let n = 0;
    const rewrite = vi.fn(async () => {
      n += 1;
      return `短${n}。`;
    });
    const result = await runQualityGate({
      bookId: "demo",
      bookDir: "/tmp",
      chapterNumber: 1,
      minWords: 1000,
      config: { enabled: true, onFail: "retry", maxRetries: 2, aiFlavorThreshold: 100 },
      text: "短。",
      persist: false,
      rewrite,
    });
    expect(result.passed).toBe(false);
    expect(result.attempts).toBe(2);
    expect(rewrite).toHaveBeenCalledTimes(2);
  });

  it("stops retrying once a rewrite passes", async () => {
    const rewrite = vi.fn(async () => CLEAN);
    const result = await runQualityGate({
      bookId: "demo",
      bookDir: "/tmp",
      chapterNumber: 1,
      minWords: 10,
      config: { enabled: true, onFail: "retry", maxRetries: 3, aiFlavorThreshold: 60 },
      text: "短。",
      persist: false,
      rewrite,
    });
    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(1);
    expect(rewrite).toHaveBeenCalledTimes(1);
  });

  it("throws QualityGatePauseError on pause", async () => {
    await expect(runQualityGate({
      bookId: "demo",
      bookDir: "/tmp",
      chapterNumber: 3,
      minWords: 1000,
      config: { enabled: true, onFail: "pause", aiFlavorThreshold: 100 },
      text: "短。",
      persist: false,
    })).rejects.toBeInstanceOf(QualityGatePauseError);
  });

  it("honours book onFail=retry over project warn and rewrites", async () => {
    const rewrite = vi.fn(async () => CLEAN);
    const result = await runQualityGate({
      bookId: "demo",
      bookDir: "/tmp",
      chapterNumber: 1,
      minWords: 10,
      config: { enabled: true, onFail: "warn", maxRetries: 1, aiFlavorThreshold: 60 },
      bookConfig: { onFail: "retry" },
      text: "短。",
      persist: false,
      rewrite,
    });
    expect(rewrite).toHaveBeenCalled();
    expect(result.attempts).toBeGreaterThanOrEqual(1);
    expect(result.passed).toBe(true);
    expect(result.content).toBe(CLEAN);
  });

  it("honours book onFail=warn over project retry and does not rewrite", async () => {
    const rewrite = vi.fn(async () => CLEAN);
    const result = await runQualityGate({
      bookId: "demo",
      bookDir: "/tmp",
      chapterNumber: 1,
      minWords: 10,
      config: { enabled: true, onFail: "retry", maxRetries: 2, aiFlavorThreshold: 60 },
      bookConfig: { onFail: "warn" },
      text: "短。",
      persist: false,
      rewrite,
    });
    expect(rewrite).not.toHaveBeenCalled();
    expect(result.attempts).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("retries when project is retry and book onFail is unset", async () => {
    const rewrite = vi.fn(async () => CLEAN);
    const result = await runQualityGate({
      bookId: "demo",
      bookDir: "/tmp",
      chapterNumber: 1,
      minWords: 10,
      config: { enabled: true, onFail: "retry", maxRetries: 1, aiFlavorThreshold: 60 },
      text: "短。",
      persist: false,
      rewrite,
    });
    expect(rewrite).toHaveBeenCalledTimes(1);
    expect(result.attempts).toBe(1);
    expect(result.passed).toBe(true);
  });

  it("does not rewrite when project defaults and book has no override", async () => {
    const rewrite = vi.fn(async () => CLEAN);
    const result = await runQualityGate({
      bookId: "demo",
      bookDir: "/tmp",
      chapterNumber: 1,
      minWords: 10,
      config: { enabled: true, onFail: "warn", maxRetries: 1, aiFlavorThreshold: 60 },
      text: "短。",
      persist: false,
      rewrite,
    });
    expect(rewrite).not.toHaveBeenCalled();
    expect(result.attempts).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("keeps last rewrite and warns after retries exhaust", async () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn() };
    const rewrite = vi.fn(async () => "短改。");
    const result = await runQualityGate({
      bookId: "demo",
      bookDir: "/tmp",
      chapterNumber: 1,
      minWords: 1000,
      config: { enabled: true, onFail: "retry", maxRetries: 1, aiFlavorThreshold: 100 },
      text: "短。",
      persist: false,
      logger,
      rewrite,
    });
    expect(rewrite).toHaveBeenCalledTimes(1);
    expect(result.passed).toBe(false);
    expect(result.content).toBe("短改。");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("throws QualityGatePauseError when book overrides project warn to pause", async () => {
    const rewrite = vi.fn(async () => CLEAN);
    await expect(runQualityGate({
      bookId: "demo",
      bookDir: "/tmp",
      chapterNumber: 3,
      minWords: 1000,
      config: { enabled: true, onFail: "warn", aiFlavorThreshold: 100 },
      bookConfig: { onFail: "pause" },
      text: "短。",
      persist: false,
      rewrite,
    })).rejects.toBeInstanceOf(QualityGatePauseError);
    expect(rewrite).not.toHaveBeenCalled();
  });

  it("appends a chapter record for Studio to read", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-qg-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    await mkdir(join(bookDir, "story"), { recursive: true });
    await writeFile(join(bookDir, "chapters", "0001_ch.md"), "# 第1章\n\n短。\n", "utf-8");

    const result = await runQualityGate({
      bookId: "demo",
      bookDir,
      chapterNumber: 1,
      minWords: 1000,
      config: { enabled: true, onFail: "warn", aiFlavorThreshold: 100 },
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect(result.passed).toBe(false);
    const payload = JSON.parse(await readFile(qualityGateJsonPath(bookDir), "utf-8"));
    expect(payload.bookId).toBe("demo");
    expect(payload.chapters).toHaveLength(1);
    expect(payload.chapters[0]).toMatchObject({
      chapterNumber: 1,
      passed: false,
      onFail: "warn",
    });
  });
});

describe("ProjectConfigSchema.qualityGate", () => {
  it("defaults to enabled warn without pinning aiFlavorThreshold", () => {
    const parsed = ProjectConfigSchema.parse({
      name: "demo",
      version: "0.1.0",
      llm: LLM,
    });
    expect(parsed.qualityGate).toMatchObject({
      enabled: true,
      minWordRatio: 0.7,
      maxRetries: 1,
      onFail: "warn",
    });
    expect(parsed.qualityGate.aiFlavorThreshold).toBeUndefined();
  });
});
