import { describe, expect, it } from "vitest";
import {
  filterActiveHooks,
  normalizeStoredHookStatus,
  resolveHookStatusAlias,
} from "../utils/hook-lifecycle.js";
import { parsePendingHooksMarkdown } from "../utils/story-markdown.js";

describe("resolveHookStatusAlias", () => {
  it.each([
    ["pressured", "progressing"],
    ["已回收", "resolved"],
    ["延后", "deferred"],
    ["paid off", "resolved"],
    ["Deferred", "deferred"],
  ])("maps the alias %s", (raw, expected) => {
    expect(resolveHookStatusAlias(raw)).toBe(expected);
  });

  it.each([
    // Rendered by the ledger projection for blocked hooks (seen in 我给仙族管账三百年).
    ["deferred (受阻于 H001 (已阻 8 章))", "deferred"],
    ["deferred（受阻于H001/H007已阻7章）", "deferred"],
    ["progressing（受阻）", "progressing"],
    ["open (过期 (距=12/半衰=8); 受阻于 H003)", "open"],
    ["progressing (blocked on H001 (blocked 3 chapters))", "progressing"],
    ["已回收：第12章揭开", "resolved"],
    ["已回收 第12章", "resolved"],
    ["延后；等H001落地", "deferred"],
    ["deferred until H001 lands", "deferred"],
  ])("ignores the annotation in %s", (raw, expected) => {
    expect(resolveHookStatusAlias(raw)).toBe(expected);
  });

  it("returns undefined for unknown statuses", () => {
    expect(resolveHookStatusAlias("??")).toBeUndefined();
    expect(resolveHookStatusAlias("")).toBeUndefined();
    expect(resolveHookStatusAlias(undefined)).toBeUndefined();
  });
});

describe("normalizeStoredHookStatus", () => {
  it("keeps suffixed deferred hooks deferred instead of reopening them", () => {
    expect(normalizeStoredHookStatus("deferred (受阻于 H001 (已阻 8 章))")).toBe("deferred");
    expect(normalizeStoredHookStatus("nonsense")).toBe("open");
  });

  it("round-trips a projected ledger row with a blocked marker", () => {
    const markdown = [
      "# 伏笔池",
      "",
      "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 回收节奏 | 上游依赖 | 回收卷 | 核心 | 半衰期 | 升级 | 备注 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      "| H005 | 0 | 后台 | deferred (受阻于 H001 (已阻 8 章)) | 0 | 430 | 慢烧 | [H001] | 卷六额外劫环见血 | 是 | 80 | 是 | 额外劫环 |",
      "| H001 | 1 | 主线 | progressing | 8 | 揭开 | 中程 |  |  | 是 | 30 | 是 | 主线 |",
    ].join("\n");
    const hooks = parsePendingHooksMarkdown(markdown);
    expect(hooks.find((hook) => hook.hookId === "H005")?.status).toBe("deferred");
    expect(filterActiveHooks(hooks).map((hook) => hook.hookId)).toEqual(["H001"]);
  });
});
