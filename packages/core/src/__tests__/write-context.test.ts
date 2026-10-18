import { describe, expect, it } from "vitest";
import {
  applyWriteContextBuckets,
  classifyWriteContextSource,
  isContextWindowGuardError,
  isJieyunBook,
  nextGuardStep,
  resolveWriteContextAttempt,
  resolveWriteContextConfig,
  resolveWriteWindow,
  shouldPredictivelyCompress,
  WRITE_CONTEXT_WINDOW_CAP,
} from "../utils/write-context.js";
import { ContextWindowExceededError } from "../llm/provider.js";

describe("write-context budget", () => {
  it("caps the write window at 128k even when the model card is larger", () => {
    const window = resolveWriteWindow({
      modelContextWindow: 2_000_000,
      reservedOutputTokens: 16_384,
    });
    expect(window.contextWindowTokens).toBe(WRITE_CONTEXT_WINDOW_CAP);
    expect(window.availableInputTokens).toBeLessThan(window.contextWindowTokens);
  });

  it("uses min(configured, 128k)", () => {
    expect(resolveWriteWindow({
      modelContextWindow: 256_000,
      reservedOutputTokens: 4_000,
      configuredContextWindow: 64_000,
    }).contextWindowTokens).toBe(64_000);
  });

  it("classifies outline / memory / rag / hooks into buckets", () => {
    expect(classifyWriteContextSource("story/outline/volume_map.md#ch4")).toBe("protected");
    expect(classifyWriteContextSource("story/chapter_summaries.md#12")).toBe("memory");
    expect(classifyWriteContextSource("story/graph#characters")).toBe("rag");
    expect(classifyWriteContextSource("story/pending_hooks.md#hook-1")).toBe("protected");
  });

  it("drops over-budget rag/other before protected sources", () => {
    const result = applyWriteContextBuckets({
      selectedContext: [
        { source: "story/author_intent.md", reason: "intent", excerpt: "keep me" },
        { source: "story/graph#events", reason: "rag", excerpt: "RAG ".repeat(4000) },
        { source: "story/chapter_summaries.md#recent_titles", reason: "trail", excerpt: "old titles" },
      ],
      availableInputTokens: 200,
      dropCompressibleTrails: true,
    });
    expect(result.selectedContext.some((entry) => entry.source === "story/author_intent.md")).toBe(true);
    expect(result.dropped.some((entry) => entry.source === "story/chapter_summaries.md#recent_titles")).toBe(true);
    expect(result.dropped.some((entry) => entry.source === "story/graph#events")
      || result.selectedContext.find((entry) => entry.source === "story/graph#events")?.excerpt?.includes("omitted")).toBe(true);
  });

  it("predicts compression near the boundary", () => {
    expect(shouldPredictivelyCompress({
      totalTokens: 90,
      availableInputTokens: 100,
      threshold: 0.85,
    })).toBe(true);
    expect(shouldPredictivelyCompress({
      totalTokens: 10,
      availableInputTokens: 100,
      threshold: 0.85,
    })).toBe(false);
  });

  it("shrinks RAG/hops across guard retries and consolidates on the last step", () => {
    const first = resolveWriteContextAttempt({
      profile: "longform-rag",
      windowCapTokens: 128_000,
      autoConsolidateOnGuard: true,
      maxGuardRetries: 2,
      predictiveThreshold: 0.85,
    }, 0);
    const last = resolveWriteContextAttempt({
      profile: "longform-rag",
      windowCapTokens: 128_000,
      autoConsolidateOnGuard: true,
      maxGuardRetries: 2,
      predictiveThreshold: 0.85,
    }, 2);
    expect(first.graphHops).toBe(2);
    expect(last.graphHops).toBe(1);
    expect(last.graphBudgetTokens).toBeLessThan(first.graphBudgetTokens);
    expect(last.consolidateBeforeCompose).toBe(true);
    expect(nextGuardStep(2, true)).toBe("consolidate");
  });

  it("recognizes context window guard errors", () => {
    expect(isContextWindowGuardError(new ContextWindowExceededError({
      estimatedInputTokens: 120_000,
      reservedOutputTokens: 16_000,
      contextWindow: 128_000,
      model: "grok-4.7",
    }))).toBe(true);
    expect(isContextWindowGuardError(new Error("maximum context length exceeded"))).toBe(true);
    expect(isContextWindowGuardError(new Error("unrelated"))).toBe(false);
  });

  it("enables longform-rag for 《劫云》 by title/id", () => {
    expect(isJieyunBook({ title: "劫云", id: "book-1" })).toBe(true);
    expect(isJieyunBook({ title: "other", id: "jieyun" })).toBe(true);
    const config = resolveWriteContextConfig(undefined, { title: "劫云", targetChapters: 800 });
    expect(config.profile).toBe("longform-rag");
    expect(config.maxGuardRetries).toBe(2);
  });
});
