import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deAIDeprecationWarningEmitted,
  resetDeAIDeprecationWarningForTests,
  resolveDeAIConfig,
} from "../deai/config.js";
import { BookConfigSchema } from "../models/book.js";
import { ProjectConfigSchema } from "../models/project.js";
import { resolveQualityGateConfig } from "../quality-gate/config.js";

const LLM = {
  provider: "anthropic" as const,
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test-key",
  model: "claude-sonnet-4-5-20250514",
};

function mockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
}

afterEach(() => {
  resetDeAIDeprecationWarningForTests();
});

describe("ProjectConfigSchema deAI", () => {
  it("leaves deAI unset with no field defaults", () => {
    const parsed = ProjectConfigSchema.parse({
      name: "p",
      version: "0.1.0",
      llm: LLM,
    });
    expect(parsed.deAI).toBeUndefined();
    expect(parsed.deslop.enabled).toBe(true);
    expect(parsed.qualityGate.enabled).toBe(true);
    expect(parsed.qualityGate.onFail).toBe("warn");
    expect(parsed.qualityGate.maxRetries).toBe(1);
    expect(parsed.detection).toBeUndefined();
  });

  it("does not fill omitted deAI fields", () => {
    const parsed = ProjectConfigSchema.parse({
      name: "p",
      version: "0.1.0",
      llm: LLM,
      deAI: { onFail: "pause" },
    });
    expect(parsed.deAI).toEqual({ onFail: "pause" });
    expect(parsed.deAI?.enabled).toBeUndefined();
    expect(parsed.deAI?.aiFlavorThreshold).toBeUndefined();
    expect(parsed.deAI?.maxRetries).toBeUndefined();
  });

  it("accepts null aiFlavorThreshold", () => {
    const parsed = ProjectConfigSchema.parse({
      name: "p",
      version: "0.1.0",
      llm: LLM,
      deAI: { aiFlavorThreshold: null, skill: "inkos-story-deslop" },
    });
    expect(parsed.deAI?.aiFlavorThreshold).toBeNull();
  });
});

describe("BookConfigSchema deAI", () => {
  const book = {
    id: "b1",
    title: "B1",
    platform: "qidian" as const,
    genre: "xianxia",
    status: "active" as const,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  it("leaves deAI unset by default", () => {
    expect(BookConfigSchema.parse(book).deAI).toBeUndefined();
  });

  it("does not fill omitted book.deAI fields", () => {
    const parsed = BookConfigSchema.parse({ ...book, deAI: { enabled: false } });
    expect(parsed.deAI).toEqual({ enabled: false });
    expect(parsed.deAI?.onFail).toBeUndefined();
    expect(parsed.deAI?.skill).toBeUndefined();
  });
});

describe("resolveDeAIConfig", () => {
  it("matches today's deslop+qualityGate defaults when deAI is absent", () => {
    const { config, sources } = resolveDeAIConfig({});
    expect(config.enabled).toBe(true);
    expect(config.rewriteEnabled).toBe(true);
    expect(config.gateEnabled).toBe(true);
    expect(config.skill).toBe("inkos-story-deslop");
    expect(config.aiFlavorThreshold).toBe(60);
    expect(config.minWordRatio).toBe(0.7);
    expect(config.maxRetries).toBe(1);
    expect(config.onFail).toBe("warn");
    expect(config.keepOriginal).toBe(true);
    expect(config.rewriteCallRetries).toBe(2);
    expect(config.externalDetect.enabled).toBe(false);
    expect(config.externalDetect.autoRewrite).toBe(false);
    expect(config.externalDetect.maxRetries).toBe(3);
    expect(sources.aiFlavorThreshold).toBe("default");
    expect(sources.maxRetries).toBe("default");
    expect(sources.rewriteCallRetries).toBe("default");
  });

  it("keeps rewriteEnabled and gateEnabled independent on un-migrated config", () => {
    const { config } = resolveDeAIConfig({
      project: {
        deslop: { enabled: false },
        qualityGate: { enabled: true },
      },
      emitDeprecation: false,
    });
    expect(config.rewriteEnabled).toBe(false);
    expect(config.gateEnabled).toBe(true);
    expect(config.enabled).toBe(false);
  });

  it("maps parsed project defaults (no deAI) to today's effective config", () => {
    const project = ProjectConfigSchema.parse({
      name: "p",
      version: "0.1.0",
      llm: LLM,
    });
    const { config } = resolveDeAIConfig({ project, emitDeprecation: false });
    expect(config.rewriteEnabled).toBe(true);
    expect(config.gateEnabled).toBe(true);
    expect(config.skill).toBe("inkos-story-deslop");
    expect(config.maxRetries).toBe(1);
    expect(config.rewriteCallRetries).toBe(2);
    expect(config.onFail).toBe("warn");
    expect(config.keepOriginal).toBe(true);
    expect(config.externalDetect.enabled).toBe(false);
  });

  it("lets the new deAI block override legacy keys", () => {
    const { config, sources, warnings } = resolveDeAIConfig({
      project: {
        deAI: {
          enabled: false,
          skill: "custom-deslop",
          aiFlavorThreshold: 40,
          minWordRatio: 0.5,
          maxRetries: 3,
          onFail: "pause",
          keepOriginal: false,
          rewriteCallRetries: 5,
          externalDetect: { enabled: true, autoRewrite: true, maxRetries: 4 },
        },
        deslop: { enabled: true, keepOriginal: true, maxRetries: 2, mode: "local" },
        qualityGate: { enabled: true, aiFlavorThreshold: 80, onFail: "warn", maxRetries: 1 },
        detection: {
          enabled: false,
          autoRewrite: false,
          maxRetries: 3,
          apiUrl: "https://detect.example/v1",
          apiKeyEnv: "DETECT_KEY",
        },
      },
      emitDeprecation: false,
    });
    expect(config.enabled).toBe(false);
    expect(config.rewriteEnabled).toBe(false);
    expect(config.gateEnabled).toBe(false);
    expect(config.skill).toBe("custom-deslop");
    expect(config.aiFlavorThreshold).toBe(40);
    expect(config.minWordRatio).toBe(0.5);
    expect(config.maxRetries).toBe(3);
    expect(config.onFail).toBe("pause");
    expect(config.keepOriginal).toBe(false);
    expect(config.rewriteCallRetries).toBe(5);
    expect(config.externalDetect.enabled).toBe(true);
    expect(config.externalDetect.autoRewrite).toBe(true);
    expect(config.externalDetect.maxRetries).toBe(4);
    expect(sources.onFail).toBe("project.deAI");
    expect(warnings.some((w) => w.includes("qualityGate.onFail") && w.includes("deAI.onFail"))).toBe(true);
  });

  it("emits a conflict warning naming both keys when deAI and legacy set the same field", () => {
    const { config, warnings } = resolveDeAIConfig({
      project: {
        deAI: { onFail: "pause" },
        qualityGate: { onFail: "warn" },
      },
      emitDeprecation: false,
    });
    expect(config.onFail).toBe("pause");
    expect(warnings).toContain("忽略 `qualityGate.onFail`，使用 `deAI.onFail`");
  });

  it("lets book.deAI beat project.deAI and book.qualityGate beat project.deAI when book.deAI omits the field", () => {
    const bookWins = resolveDeAIConfig({
      project: { deAI: { onFail: "warn", maxRetries: 2, aiFlavorThreshold: 80 } },
      book: { deAI: { onFail: "pause", maxRetries: 0 } },
      emitDeprecation: false,
    });
    expect(bookWins.config.onFail).toBe("pause");
    expect(bookWins.config.maxRetries).toBe(0);
    expect(bookWins.config.aiFlavorThreshold).toBe(80);
    expect(bookWins.sources.onFail).toBe("book.deAI");

    const bookLegacy = resolveDeAIConfig({
      project: { deAI: { onFail: "pause" } },
      book: { qualityGate: { onFail: "retry" } },
      emitDeprecation: false,
    });
    expect(bookLegacy.config.onFail).toBe("retry");
    expect(bookLegacy.sources.onFail).toBe("book.qualityGate");
  });

  it("uses preset threshold 55 for zhihu-short and 60 otherwise", () => {
    expect(resolveDeAIConfig({ preset: "zhihu-short" }).config.aiFlavorThreshold).toBe(55);
    expect(resolveDeAIConfig({ preset: "qidian" }).config.aiFlavorThreshold).toBe(60);
    expect(resolveDeAIConfig({}).config.aiFlavorThreshold).toBe(60);
    expect(resolveDeAIConfig({
      project: { deAI: { aiFlavorThreshold: null } },
      preset: "zhihu-short",
    }).config.aiFlavorThreshold).toBe(55);
    expect(resolveDeAIConfig({
      project: { deAI: { aiFlavorThreshold: 70 } },
      preset: "zhihu-short",
    }).config.aiFlavorThreshold).toBe(70);
  });

  it("maps deslop.maxRetries to rewriteCallRetries, not maxRetries", () => {
    const { config, sources } = resolveDeAIConfig({
      project: {
        deslop: { maxRetries: 9, mode: "full" },
        qualityGate: { maxRetries: 1 },
      },
      emitDeprecation: false,
    });
    expect(config.rewriteCallRetries).toBe(9);
    expect(config.maxRetries).toBe(1);
    expect(config.skill).toBe("inkos-story-deslop-full");
    expect(sources.rewriteCallRetries).toBe("project.deslop");
    expect(sources.maxRetries).toBe("project.qualityGate");
  });

  it("maps detection.enabled to externalDetect.enabled with default false", () => {
    expect(resolveDeAIConfig({}).config.externalDetect.enabled).toBe(false);
    const on = resolveDeAIConfig({
      project: {
        detection: {
          enabled: true,
          autoRewrite: true,
          maxRetries: 6,
          apiUrl: "https://detect.example/v1",
          apiKeyEnv: "DETECT_KEY",
          provider: "custom",
          threshold: 0.8,
        },
      },
      emitDeprecation: false,
    });
    expect(on.config.externalDetect.enabled).toBe(true);
    expect(on.config.externalDetect.autoRewrite).toBe(true);
    expect(on.config.externalDetect.maxRetries).toBe(6);
    expect(on.config.externalDetect.apiUrl).toBe("https://detect.example/v1");
    expect(on.config.externalDetect.threshold).toBe(0.8);
    expect(on.sources["externalDetect.enabled"]).toBe("project.detection");
  });

  it("lets CLI/API overrides win over book and project", () => {
    const { config, sources } = resolveDeAIConfig({
      project: { deAI: { onFail: "warn", aiFlavorThreshold: 80 } },
      book: { deAI: { onFail: "pause", aiFlavorThreshold: 40 } },
      overrides: { onFail: "retry", aiFlavorThreshold: 33 },
      emitDeprecation: false,
    });
    expect(config.onFail).toBe("retry");
    expect(config.aiFlavorThreshold).toBe(33);
    expect(sources.onFail).toBe("overrides");
    expect(sources.aiFlavorThreshold).toBe("overrides");
  });

  it("emits one deprecation warning per process when legacy keys are present", () => {
    const logger = mockLogger();
    resolveDeAIConfig({
      project: { qualityGate: { onFail: "warn" } },
      logger,
    });
    resolveDeAIConfig({
      project: { deslop: { enabled: true } },
      logger,
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]?.[0])).toMatch(/deAI/);
    expect(deAIDeprecationWarningEmitted()).toBe(true);
  });

  it("does not emit deprecation when only deAI is present", () => {
    const logger = mockLogger();
    resolveDeAIConfig({
      project: { deAI: { enabled: true } },
      logger,
    });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(deAIDeprecationWarningEmitted()).toBe(false);
  });
});

describe("resolveQualityGateConfig (delegates, callers unchanged)", () => {
  it("still merges explicit threshold over platformPreset over 60", () => {
    expect(resolveQualityGateConfig(undefined, undefined, undefined).aiFlavorThreshold).toBe(60);
    expect(resolveQualityGateConfig(undefined, undefined, "zhihu-short").aiFlavorThreshold).toBe(55);
    expect(resolveQualityGateConfig({ aiFlavorThreshold: 80 }, undefined, "zhihu-short").aiFlavorThreshold).toBe(80);
    expect(resolveQualityGateConfig(
      { aiFlavorThreshold: 80 },
      { aiFlavorThreshold: 40 },
      "zhihu-short",
    ).aiFlavorThreshold).toBe(40);
  });

  it("does not trip the deAI deprecation warning", () => {
    const logger = mockLogger();
    resolveQualityGateConfig({ enabled: true, onFail: "warn" }, { onFail: "pause" }, "qidian");
    expect(deAIDeprecationWarningEmitted()).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
