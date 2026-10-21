export type OpeningCheckItemId = number | "5a" | "5b";

export interface OpeningCheckItemDef {
  readonly id: OpeningCheckItemId;
  readonly title: string;
  readonly criterion: string;
}

/** Opening checklist items 1–8 plus hard-gate splits 5a/5b. Item 9 in the source doc is the output format. */
export const OPENING_CHECK_ITEMS: readonly OpeningCheckItemDef[] = [
  {
    id: 1,
    title: "有效剧情",
    criterion: "每场戏/对话是否体现人设+情绪；纯背景交代 >300 字即标红",
  },
  {
    id: 2,
    title: "开场",
    criterion: "意象+镜头感进入场景，通过角色对话引出困境与世道",
  },
  {
    id: 3,
    title: "主角处境",
    criterion: "比同伴更惨，能引发代入/共情",
  },
  {
    id: 4,
    title: "开局人物",
    criterion: "开局人物 ≤3 组（上位压制 / 主角 / 陪衬）",
  },
  {
    id: 5,
    title: "金手指",
    criterion: "给出选择，并与眼前屈辱直接挂钩；黄金 500 字内出现钩子",
  },
  {
    id: "5a",
    title: "金手指",
    criterion: "给出金手指选择，并与眼前屈辱直接挂钩",
  },
  {
    id: "5b",
    title: "黄金500字钩",
    criterion: "黄金 500 字内出现钩子（能力预兆或金手指入口）",
  },
  {
    id: 6,
    title: "读者疑问",
    criterion: "读者疑问由配角替读者问出（如钱从哪来）",
  },
  {
    id: 7,
    title: "前期小 boss",
    criterion: "当前能碾压主角，有冲突与伏笔",
  },
  {
    id: 8,
    title: "变强后回归",
    criterion: "变强后回归当下困境（反哺家庭/打脸），而不是一路升级",
  },
];

export const OPENING_CHECK_OUTPUT_FORMAT =
  "逐条 通过/不通过 + 原文引用 + 修改建议";

/** Display checklist 1–8 (item 5 remains the combined 金手指 row). */
export const OPENING_CHECK_DISPLAY_ITEMS: readonly OpeningCheckItemDef[] = OPENING_CHECK_ITEMS.filter(
  (item) => typeof item.id === "number",
);

export const OPENING_CHECK_ITEM_IDS: readonly OpeningCheckItemId[] = OPENING_CHECK_ITEMS.map((item) => item.id);

export const OPENING_HARD_GATE_IDS = ["5a", "5b", 7] as const;
export type OpeningHardGateId = (typeof OPENING_HARD_GATE_IDS)[number];

export function openingCheckItemById(id: OpeningCheckItemId | string | number): OpeningCheckItemDef | undefined {
  return OPENING_CHECK_ITEMS.find((item) => String(item.id) === String(id));
}

export function normalizeOpeningCheckItemId(value: unknown): OpeningCheckItemId | undefined {
  if (value === "5a" || value === "5b") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "5a" || trimmed === "5b") return trimmed;
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isInteger(n) && n >= 1 && n <= 8) return n;
    }
    return undefined;
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 8) return value;
  return undefined;
}
