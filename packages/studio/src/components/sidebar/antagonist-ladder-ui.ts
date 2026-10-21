import { tr } from "../../lib/app-language";
import type { LadderPresence, OppositionRung } from "../../lib/antagonist-ladder";

export const LADDER_TITLE = (): string => tr("对立面与对抗升级", "Opposition & Ladder");
export const LADDER_SUBTITLE = (): string =>
  tr("主线矛盾进阶总览（天道为底座规则，非具体反派）", "Conflict ladder (Heavenly Dao is rules, not villain)");
export const LADDER_VOLUME_MAP_LINK = (): string => tr("卷纲细读 ↗", "Volume Map ↗");
export const LADDER_UNPLANNED = (): string => tr("未规划", "Unplanned");
export const LADDER_EMPTY_TITLE = (): string => tr("暂未设定对立阶梯", "No Opposition Defined");
export const LADDER_EMPTY_HINT = (): string =>
  tr("在卷纲规划中完善各卷对抗与破局点后自动生成", "Fill in volume map to generate opposition ladder");
export const LADDER_EMPTY_CTA = (): string => tr("前往卷纲规划完善 →", "Complete the volume map →");
export const LADDER_RULE_REWRITE = (): string => tr("规则重构", "Rule rewrite");
export const LADDER_CRISIS = (): string => tr("危机", "Crisis");
export const LADDER_COUNTERMOVE = (): string => tr("↳ 破局", "↳ Countermove");

export function expandRemainingLabel(count: number): string {
  return tr(`展开余下 ${count} 卷 ▾`, `Show remaining ${count} vols ▾`);
}

export function shouldRenderLadder(presence: LadderPresence): boolean {
  return presence !== "missing";
}

export function shouldCollapseEmpty(presence: LadderPresence): boolean {
  return presence === "empty";
}

export function rungAriaLabel(rung: OppositionRung): string {
  const parts = [rung.opponent, rung.crisis, rung.countermove].filter(Boolean);
  return parts.join(" · ");
}
