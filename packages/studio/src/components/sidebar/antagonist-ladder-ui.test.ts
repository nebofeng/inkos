import { afterEach, describe, expect, it } from "vitest";
import { setAppLanguage } from "../../lib/app-language";
import { parseOppositionLadder, ladderPresence } from "../../lib/antagonist-ladder";
import {
  LADDER_RULE_REWRITE,
  LADDER_SUBTITLE,
  LADDER_TITLE,
  expandRemainingLabel,
  shouldCollapseEmpty,
  shouldRenderLadder,
} from "./antagonist-ladder-ui";

afterEach(() => setAppLanguage("zh"));

const SEEDED = `---
opposition_ladder:
  - volume: 1
    opponent: 安心渡 / 钱多福
    crisis: 渡劫转包黑账
    countermove: 追索法器坏账
  - volume: 5
    opponent: 改写量劫底层规则
    crisis: 旧机制坍塌
    countermove: 重写天道审计
    kind: rule_rewrite
---
`;

describe("antagonist ladder copy + presence", () => {
  it("renders seeded rungs with rule-rewrite copy in zh", () => {
    const rungs = parseOppositionLadder(SEEDED);
    expect(rungs).toHaveLength(2);
    expect(rungs[0].opponent).toContain("安心渡");
    expect(rungs[1].finale).toBe(true);
    expect(LADDER_TITLE()).toBe("对立面与对抗升级");
    expect(LADDER_SUBTITLE()).toMatch(/天道为底座规则/);
    expect(LADDER_RULE_REWRITE()).toBe("规则重构");
    expect(expandRemainingLabel(3)).toBe("展开余下 3 卷 ▾");
    expect(shouldRenderLadder(ladderPresence({ fileFound: true, volumeMapFound: true, rungs }))).toBe(true);
    expect(shouldCollapseEmpty(ladderPresence({ fileFound: true, volumeMapFound: true, rungs }))).toBe(false);
  });

  it("does not invent jieyun rungs when a book has no ladder data", () => {
    const rungs = parseOppositionLadder("");
    expect(rungs).toEqual([]);
    expect(rungs.some((r) => r.opponent.includes("安心渡"))).toBe(false);
    const presence = ladderPresence({ fileFound: false, volumeMapFound: false, rungs });
    expect(shouldRenderLadder(presence)).toBe(false);
    expect(shouldCollapseEmpty(presence)).toBe(false);
  });

  it("collapses (does not hide) when volume_map exists but ladder parse is empty", () => {
    const presence = ladderPresence({ fileFound: false, volumeMapFound: true, rungs: [] });
    expect(shouldRenderLadder(presence)).toBe(true);
    expect(shouldCollapseEmpty(presence)).toBe(true);
  });

  it("switches copy to English", () => {
    setAppLanguage("en");
    expect(LADDER_TITLE()).toBe("Opposition & Ladder");
    expect(LADDER_RULE_REWRITE()).toBe("Rule rewrite");
  });
});
