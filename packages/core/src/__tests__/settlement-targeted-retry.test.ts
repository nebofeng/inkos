import { describe, expect, it, vi } from "vitest";
import type { ValidationResult } from "../agents/state-validator.js";
import type { WriteChapterOutput } from "../agents/writer.js";
import type { BookConfig } from "../models/book.js";
import { RuntimeStateDeltaSchema } from "../models/runtime-state.js";
import {
  buildTargetedSettlementFeedback,
  extractFlaggedHookIds,
  resolveSettlementRetryAttempts,
  retrySettlementAfterValidationFailure,
} from "../pipeline/chapter-state-recovery.js";

const BOOK: BookConfig = {
  id: "b", title: "B", platform: "tomato", genre: "xuanhuan", status: "active",
  targetChapters: 10, chapterWordCount: 3000,
  createdAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-01T00:00:00.000Z",
};

const LEDGER = [
  "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  "| H002 | 1 | 人物 | open | 2 | 白发 | 白发未解 |",
  "| H023 | 12 | 人物 | open | 12 | 劫引解除 | 马跃喝下药水 |",
  "| H024 | 12 | 曝光 | open | 12 | 场内曝光 | 有人喊 |",
].join("\n");

const DELTA = RuntimeStateDeltaSchema.parse({
  chapter: 13,
  hookOps: {
    upsert: [{ hookId: "H023", startChapter: 12, type: "人物", status: "open", lastAdvancedChapter: 12, expectedPayoff: "劫引解除", notes: "未更新" }],
    mention: ["H024"],
  },
});

const warnings = [
  { category: "state-validation", description: "H023应推进：马跃已离场并交顾晴" },
  { category: "state-validation", description: "H024/H020应推进：喊破之后有一拳落地" },
];

function output(overrides: Partial<WriteChapterOutput> = {}): WriteChapterOutput {
  return {
    chapterNumber: 13, title: "十三", content: "正文", wordCount: 2, preWriteCheck: "ok", postSettlement: "ok",
    updatedState: "state", updatedLedger: "", updatedHooks: LEDGER, chapterSummary: "", updatedSubplots: "",
    updatedEmotionalArcs: "", updatedCharacterMatrix: "", postWriteErrors: [], postWriteWarnings: [],
    ...overrides,
  } as WriteChapterOutput;
}

const failing = (list = warnings): ValidationResult => ({ passed: false, repairRequired: true, warnings: list });
const passing: ValidationResult = { passed: true, warnings: [] };

describe("resolveSettlementRetryAttempts", () => {
  it("defaults to 1 and reads INKOS_STATE_VALIDATION_RETRIES, clamped to 1..5", () => {
    expect(resolveSettlementRetryAttempts(undefined, {})).toBe(1);
    expect(resolveSettlementRetryAttempts(undefined, { INKOS_STATE_VALIDATION_RETRIES: "3" })).toBe(3);
    expect(resolveSettlementRetryAttempts(undefined, { INKOS_STATE_VALIDATION_RETRIES: "99" })).toBe(5);
    expect(resolveSettlementRetryAttempts(0, {})).toBe(1);
    expect(resolveSettlementRetryAttempts(2, { INKOS_STATE_VALIDATION_RETRIES: "4" })).toBe(2);
  });
});

describe("targeted settlement feedback", () => {
  it("only flags hook ids that exist in the ledgers", () => {
    expect(extractFlaggedHookIds(warnings, ["H002", "H023", "H024"])).toEqual(["H023", "H024"]);
  });

  it("pins flagged hook rows and hands back the rejected delta as the draft", () => {
    const feedback = buildTargetedSettlementFeedback({
      warnings,
      language: "zh",
      previousOutput: { updatedHooks: LEDGER, updatedState: "state", runtimeStateDelta: DELTA },
      oldHooks: LEDGER,
    });
    expect(feedback).toContain("H023应推进");
    expect(feedback).toContain("校验点名的伏笔：H023、H024");
    expect(feedback).toContain("| H023 | 12 | 人物 | open | 12 | 劫引解除 | 马跃喝下药水 |");
    expect(feedback).not.toContain("| H002 |");
    expect(feedback).toContain("以它为底稿");
    expect(feedback).toContain('"hookId": "H023"');
  });

  it("falls back to the plain feedback when nothing can be targeted", () => {
    const feedback = buildTargetedSettlementFeedback({
      warnings: [{ category: "x", description: "状态卡缺少位置" }],
      language: "zh",
    });
    expect(feedback).toBe("上一次状态结算未通过校验。请对照正文修正以下矛盾：\n- [x] 状态卡缺少位置");
  });
});

describe("retrySettlementAfterValidationFailure with several attempts", () => {
  it("keeps retrying with the latest warnings and recovers on the second attempt", async () => {
    const feedbacks: string[] = [];
    const secondDelta = RuntimeStateDeltaSchema.parse({ chapter: 13, hookOps: { mention: ["H023"] } });
    const settle = vi.fn(async (input: { validationFeedback?: string }) => {
      feedbacks.push(input.validationFeedback ?? "");
      return output({ runtimeStateDelta: feedbacks.length === 1 ? secondDelta : DELTA });
    });
    const validate = vi.fn()
      .mockResolvedValueOnce(failing([{ category: "state-validation", description: "H024 仍未推进" }]))
      .mockResolvedValueOnce(passing);

    const result = await retrySettlementAfterValidationFailure({
      writer: { settleChapterState: settle } as never,
      validator: { validate } as never,
      book: BOOK, bookDir: "/tmp/b", chapterNumber: 13, title: "十三", content: "正文",
      oldState: "old", oldHooks: LEDGER,
      originalValidation: failing(),
      previousOutput: output({ runtimeStateDelta: DELTA }),
      maxAttempts: 3,
      language: "zh",
    });

    expect(result.kind).toBe("recovered");
    expect(settle).toHaveBeenCalledTimes(2);
    expect(feedbacks[0]).toContain("H023应推进");
    expect(feedbacks[0]).toContain("校验点名的伏笔：H023、H024");
    // Second attempt is driven by the second validation result and the first retry's delta.
    expect(feedbacks[1]).toContain("H024 仍未推进");
    expect(feedbacks[1]).not.toContain("H023应推进");
    expect(feedbacks[1]).toContain('"mention": [\n      "H023"');
  });

  it("degrades with the last warnings after exhausting the attempts", async () => {
    const settle = vi.fn(async () => output());
    const validate = vi.fn(async () => failing([{ category: "state-validation", description: "仍然不对" }]));
    const result = await retrySettlementAfterValidationFailure({
      writer: { settleChapterState: settle } as never,
      validator: { validate } as never,
      book: BOOK, bookDir: "/tmp/b", chapterNumber: 13, title: "十三", content: "正文",
      oldState: "old", oldHooks: LEDGER,
      originalValidation: failing(),
      maxAttempts: 2,
      language: "zh",
    });
    expect(settle).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ kind: "degraded", issues: [{ description: "仍然不对" }] });
  });
});
