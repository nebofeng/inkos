import { describe, expect, it, vi } from "vitest";
import { diffHookLedgers, renderHookLedgerDiff } from "../utils/hook-ledger-diff.js";
import { StateValidatorAgent } from "../agents/state-validator.js";

const HEADER = [
  "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 回收节奏 | 上游依赖 | 回收卷 | 核心 | 半衰期 | 升级 | 备注 |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];
const ledger = (...rows: string[]) => ["# 伏笔池", "", ...HEADER, ...rows].join("\n");

const OLD = ledger(
  "| H001 | 1 | 主线 | progressing | 12 | 揭开劫吏身份 | 中程 |  |  | 是 | 30 | 是 | 第12章：宣令生效 |",
  "| H005 | 0 | 后台 | deferred (受阻于 H001 (已阻 7 章)) | 0 | 卷六 | 慢烧 | [H001] |  | 是 | 80 | 是 | 额外劫环 |",
  "| H011 | 3 | 物证 | open | 9 | 阵主是谁 | 中程 |  |  | 否 | 30 | 是 | 十三人阵 |",
  "| H023 | 12 | 人物 | open | 12 | 劫引解除 | 近期 |  |  | 否 | 10 | 是 | 马跃喝下药水 |",
);
const NEW = ledger(
  "| H001 | 1 | 主线 | progressing | 12 | 揭开劫吏身份 | 中程 |  |  | 是 | 30 | 是 | 第12章：宣令生效 |",
  // Only the blocked distance in the marker changed -> not a hook change.
  "| H005 | 0 | 后台 | deferred (受阻于 H001 (已阻 8 章)) | 0 | 卷六 | 慢烧 | [H001] |  | 是 | 80 | 是 | 额外劫环 |",
  "| H023 | 12 | 人物 | progressing | 13 | 劫引解除 | 近期 |  |  | 否 | 10 | 是 | 马跃喝下药水；第13章：已交顾晴 |",
  "| H026 | 13 | 悬疑 | open | 13 | 内间说提前 | 近期 |  |  | 否 | 10 | 否 | 第13章：钱多福说提前 |",
);

describe("diffHookLedgers", () => {
  it("reports per hookId, per field changes and ignores diagnostic markers", () => {
    const diff = diffHookLedgers(OLD, NEW)!;
    expect(diff.changed).toEqual([{
      hookId: "H023",
      fields: [
        'status: "open" -> "progressing"',
        'lastAdvancedChapter: "12" -> "13"',
        'notes: "马跃喝下药水" -> "马跃喝下药水；第13章：已交顾晴"',
      ],
    }]);
    expect(diff.added.map((line) => line.split(":")[0])).toEqual(["H026"]);
    expect(diff.removed.map((line) => line.split(":")[0])).toEqual(["H011"]);
    expect(diff.unchanged).toEqual(["H001", "H005"]);

    const rendered = renderHookLedgerDiff(diff)!;
    expect(rendered).toContain("~ H023");
    expect(rendered).toContain("- H011");
    expect(rendered).toContain("Unchanged (kept as before, not dropped): H001, H005");
  });

  it("returns null when a side is not a parseable ledger", () => {
    expect(diffHookLedgers("(状态卡未更新)", NEW)).toBeNull();
  });

  it("renders nothing when only markers changed", () => {
    const a = ledger("| H005 | 0 | 后台 | deferred (受阻于 H001 (已阻 7 章)) | 0 | 卷六 | 慢烧 | [H001] |  | 是 | 80 | 是 | 额外劫环 |");
    const b = ledger("| H005 | 0 | 后台 | deferred (受阻于 H001 (已阻 8 章)) | 0 | 卷六 | 慢烧 | [H001] |  | 是 | 80 | 是 | 额外劫环 |");
    expect(renderHookLedgerDiff(diffHookLedgers(a, b)!)).toBeNull();
  });
});

describe("StateValidatorAgent hook diff", () => {
  it("sends the per-field hook diff to the model", async () => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: { temperature: 0, maxTokens: 512, thinkingBudget: 0, extra: {} },
      },
      model: "m",
      projectRoot: "/tmp",
    } as never);
    const chat = vi.spyOn(agent as never, "chat" as never).mockResolvedValue({ content: "PASS", usage: {} } as never);

    await agent.validate("正文", 13, "state", "state", OLD, NEW, "zh");

    const userPrompt = (chat.mock.calls[0]?.[0] as Array<{ content: string }>)[1]!.content;
    expect(userPrompt).toContain("### Hooks Pool (per hookId, per field)");
    expect(userPrompt).toContain('status: "open" -> "progressing"');
    expect(userPrompt).not.toContain("已阻 7 章");
  });

  it("skips the model call when only hook diagnostics changed", async () => {
    const agent = new StateValidatorAgent({
      client: { provider: "openai", apiFormat: "chat", stream: false, defaults: { temperature: 0, maxTokens: 512, thinkingBudget: 0, extra: {} } },
      model: "m",
      projectRoot: "/tmp",
    } as never);
    const chat = vi.spyOn(agent as never, "chat" as never);
    const a = ledger("| H005 | 0 | 后台 | deferred (受阻于 H001 (已阻 7 章)) | 0 | 卷六 | 慢烧 | [H001] |  | 是 | 80 | 是 | 额外劫环 |");
    const b = ledger("| H005 | 0 | 后台 | deferred (受阻于 H001 (已阻 8 章)) | 0 | 卷六 | 慢烧 | [H001] |  | 是 | 80 | 是 | 额外劫环 |");

    await expect(agent.validate("正文", 13, "s", "s", a, b, "zh")).resolves.toMatchObject({ passed: true });
    expect(chat).not.toHaveBeenCalled();
  });
});
