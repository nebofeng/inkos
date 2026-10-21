import { describe, expect, it } from "vitest";
import {
  collapsedRungCount,
  formatVolumeLabel,
  ladderPresence,
  parseOppositionLadder,
  previewLadderRungs,
} from "./antagonist-ladder";

const JIEYUN_YAML = `---
opposition_ladder:
  - volume: 1
    opponent: 安心渡 / 钱多福
    crisis: 渡劫转包黑账，功德被克扣当炮灰
    countermove: 借天劫合规法追索法器坏账
  - volume: 2
    opponent: 冯德海 / 承劫保险
    crisis: 金融盘剥散修，资本化垄断避劫渠道
    countermove: 穿透假保单，引爆天道反洗钱复核
  - volume: 3
    opponent: 移劫门
    crisis: 系统性转嫁业力，底层修士替大宗门顶雷
    countermove: 重构因果溯源链，截断避税通道
  - volume: 4
    opponent: 司空晦
    crisis: 执掌旧秩序的既得利益代行者全面清算主角
    countermove: 策反中间层执行官，瓦解执行链
  - volume: 5
    opponent: 改写量劫底层规则
    crisis: 旧量劫机制僵化坍塌，三界同归于尽
    countermove: 重写天道审计架构，将灭世量劫转为自动化迭代机制
    kind: rule_rewrite
---

主线对抗阶梯，天道是规则不是反派。
`;

describe("parseOppositionLadder", () => {
  it("parses YAML opposition_ladder into five rungs with a finale rule-rewrite", () => {
    const rungs = parseOppositionLadder(JIEYUN_YAML);
    expect(rungs).toHaveLength(5);
    expect(rungs[0]).toMatchObject({
      opponent: "安心渡 / 钱多福",
      crisis: "渡劫转包黑账，功德被克扣当炮灰",
      countermove: "借天劫合规法追索法器坏账",
      volumeNumber: 1,
      finale: false,
    });
    expect(rungs[4].opponent).toBe("改写量劫底层规则");
    expect(rungs[4].finale).toBe(true);
    expect(rungs.map((r) => r.opponent)).toEqual([
      "安心渡 / 钱多福",
      "冯德海 / 承劫保险",
      "移劫门",
      "司空晦",
      "改写量劫底层规则",
    ]);
  });

  it("parses a markdown table with zh headers", () => {
    const md = [
      "| 卷次 | 对立面 | 面临危机 | 破局解法 |",
      "| --- | --- | --- | --- |",
      "| 第1卷 | 甲 | 被克扣 | 追索 |",
      "| 终局 | 改规则 | 坍塌 | 重写 |",
    ].join("\n");
    const rungs = parseOppositionLadder(md);
    expect(rungs).toHaveLength(2);
    expect(rungs[0].opponent).toBe("甲");
    expect(rungs[0].volumeNumber).toBe(1);
    expect(rungs[1].finale).toBe(true);
  });

  it("maps problem/win aliases used by early seed drafts", () => {
    const raw = [
      "---",
      "opposition_ladder:",
      '  - volume: "第1卷"',
      '    opponent: "安心渡 / 钱多福"',
      '    problem: "基层渡劫指标与人情债缠身"',
      '    win: "拆穿指标游戏"',
      "---",
    ].join("\n");
    const rungs = parseOppositionLadder(raw);
    expect(rungs).toHaveLength(1);
    expect(rungs[0].crisis).toBe("基层渡劫指标与人情债缠身");
    expect(rungs[0].countermove).toBe("拆穿指标游戏");
    expect(rungs[0].volumeNumber).toBe(1);
  });

  it("parses antagonist_arc alias and Chinese YAML keys", () => {
    const raw = [
      "---",
      "antagonist_arc:",
      "  - 卷次: 2",
      "    对立面: 承劫保险",
      "    危机: 假保单",
      "    破局: 反洗钱",
      "---",
    ].join("\n");
    const rungs = parseOppositionLadder(raw);
    expect(rungs).toEqual([
      {
        volume: "2",
        volumeNumber: 2,
        opponent: "承劫保险",
        crisis: "假保单",
        countermove: "反洗钱",
        finale: false,
      },
    ]);
  });

  it("returns [] for null, blank, and broken input — never invents sample rungs", () => {
    expect(parseOppositionLadder(null)).toEqual([]);
    expect(parseOppositionLadder("")).toEqual([]);
    expect(parseOppositionLadder("   \n")).toEqual([]);
    expect(parseOppositionLadder("# 卷纲\n第一卷写开端。")).toEqual([]);
    expect(parseOppositionLadder("---\nversion: \"1.0\"\n---\n散文而已。")).toEqual([]);
    const broken = parseOppositionLadder("---\nopposition_ladder: not-a-list\n---\n");
    expect(broken).toEqual([]);
    expect(broken.map((r) => r.opponent).join()).not.toMatch(/安心渡|移劫门|司空晦/);
  });

  it("drops rows that have no opponent or no crisis/countermove", () => {
    const md = [
      "| 卷次 | 对立面 | 面临危机 | 破局解法 |",
      "| --- | --- | --- | --- |",
      "| 1 |  | 有危机 | 有破局 |",
      "| 2 | 有人 |  |  |",
      "| 3 | 有人 | 有危机 |  |",
    ].join("\n");
    const rungs = parseOppositionLadder(md);
    expect(rungs).toHaveLength(1);
    expect(rungs[0].opponent).toBe("有人");
    expect(rungs[0].crisis).toBe("有危机");
  });
});

describe("ladderPresence", () => {
  it("hides when neither antagonist_arc nor volume_map exists", () => {
    expect(ladderPresence({ fileFound: false, volumeMapFound: false, rungs: [] })).toBe("missing");
  });

  it("collapses when a file exists but parse is empty", () => {
    expect(ladderPresence({ fileFound: false, volumeMapFound: true, rungs: [] })).toBe("empty");
    expect(ladderPresence({ fileFound: true, volumeMapFound: false, rungs: [] })).toBe("empty");
  });

  it("is ready when rungs exist even without volume_map", () => {
    expect(
      ladderPresence({
        fileFound: true,
        volumeMapFound: false,
        rungs: [{ volume: "1", volumeNumber: 1, opponent: "甲", crisis: "危", countermove: "破", finale: false }],
      }),
    ).toBe("ready");
  });
});

describe("previewLadderRungs", () => {
  const five = [1, 2, 3, 4, 5].map((n) => ({
    volume: String(n),
    volumeNumber: n,
    opponent: `o${n}`,
    crisis: `c${n}`,
    countermove: `w${n}`,
    finale: n === 5,
  }));

  it("shows all rungs on desktop", () => {
    expect(previewLadderRungs(five, { mobile: false, expanded: false })).toHaveLength(5);
  });

  it("on mobile, folds to the first two when there are more than three rungs", () => {
    expect(previewLadderRungs(five, { mobile: true, expanded: false })).toHaveLength(2);
    expect(collapsedRungCount(five, { mobile: true, expanded: false })).toBe(3);
    expect(previewLadderRungs(five, { mobile: true, expanded: true })).toHaveLength(5);
  });

  it("does not fold three or fewer rungs on mobile", () => {
    expect(previewLadderRungs(five.slice(0, 3), { mobile: true, expanded: false })).toHaveLength(3);
  });
});

describe("formatVolumeLabel", () => {
  it("formats numeric volumes and finale markers", () => {
    expect(formatVolumeLabel(1)).toBe("第1卷");
    expect(formatVolumeLabel("第2卷")).toBe("第2卷");
    expect(formatVolumeLabel("终局")).toBe("终局");
    expect(formatVolumeLabel(5, "en")).toBe("Vol. 5");
    expect(formatVolumeLabel("finale", "en")).toBe("Finale");
  });
});
