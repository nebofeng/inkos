import { describe, expect, it } from "vitest";
import { applyChapterHookPromotion } from "../pipeline/chapter-hook-promotion.js";
import type { RuntimeStateSnapshot } from "../state/state-reducer.js";
import { renderHooksProjection } from "../state/state-projections.js";
import { parsePendingHooksMarkdown } from "../utils/story-markdown.js";

const SUMMARIES = [
  "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  "| 7 | 七 | 甲 | 事 | 变 | H010 推进 | 紧 | 主线 |",
  "| 8 | 八 | 甲 | 事 | 变 | H010 推进 | 紧 | 主线 |",
].join("\n");

function snapshot(): RuntimeStateSnapshot {
  return {
    manifest: { schemaVersion: 2, language: "zh", lastAppliedChapter: 8, projectionVersion: 1, migrationWarnings: [] },
    currentState: { chapter: 8, facts: [] },
    chapterSummaries: { rows: [] },
    hooks: {
      hooks: [
        { hookId: "H001", startChapter: 1, type: "主线", status: "open", lastAdvancedChapter: 1, expectedPayoff: "揭开", notes: "主线", promoted: true },
        // Blocked by H001 for many chapters -> projection renders "deferred (受阻于 H001 …)".
        { hookId: "H005", startChapter: 0, type: "后台", status: "deferred", lastAdvancedChapter: 0, expectedPayoff: "卷六", notes: "额外劫环", dependsOn: ["H001"], halfLifeChapters: 80, promoted: true },
        // Seed advanced twice in summaries -> gets promoted by this pass.
        { hookId: "H010", startChapter: 6, type: "合作边界", status: "progressing", lastAdvancedChapter: 8, expectedPayoff: "边界", notes: "第8章：推进", promoted: false },
      ],
    },
  };
}

describe("applyChapterHookPromotion", () => {
  it("promotes from the runtime snapshot without reopening annotated deferred hooks", () => {
    const snap = snapshot();
    const ledger = renderHooksProjection(snap.hooks, "zh", { currentChapter: 8 });
    expect(ledger).toMatch(/deferred \(受阻于 H001/);

    const result = applyChapterHookPromotion(
      { updatedHooks: ledger, runtimeStateSnapshot: snap },
      SUMMARIES,
      "zh",
      8,
    );

    expect(result.updated).toBe(true);
    expect(result.flippedCount).toBe(1);
    const hooks = result.runtimeStateSnapshot!.hooks.hooks;
    expect(hooks.find((hook) => hook.hookId === "H005")).toMatchObject({ status: "deferred", dependsOn: ["H001"], halfLifeChapters: 80 });
    expect(hooks.find((hook) => hook.hookId === "H010")?.promoted).toBe(true);
    // The re-rendered ledger keeps the projection format (diagnostic markers included).
    expect(result.updatedHooks).toMatch(/deferred \(受阻于 H001/);
    expect(parsePendingHooksMarkdown(result.updatedHooks).find((hook) => hook.hookId === "H005")?.status).toBe("deferred");
  });

  it("leaves output untouched when nothing is promoted", () => {
    const snap = snapshot();
    const result = applyChapterHookPromotion({ updatedHooks: "ledger", runtimeStateSnapshot: snap }, "", "zh", 8);
    expect(result).toEqual({ updated: false, flippedCount: 0, updatedHooks: "ledger", runtimeStateSnapshot: snap });
  });

  it("falls back to the markdown ledger for legacy settlements", () => {
    const ledger = renderHooksProjection(snapshot().hooks, "zh");
    const result = applyChapterHookPromotion({ updatedHooks: ledger }, SUMMARIES, "zh", 8);
    expect(result.updated).toBe(true);
    expect(result.runtimeStateSnapshot).toBeUndefined();
    expect(parsePendingHooksMarkdown(result.updatedHooks).find((hook) => hook.hookId === "H010")?.promoted).toBe(true);
  });
});
