/**
 * Ported from WenlanAI backend/app/services/platform_presets.py (rev 3884ebf1b90922b439ae70004403dfd17a0bd5ca), GPL-3.0; combined into InkOS under AGPL-3.0 (GPL-3.0 §13).
 *
 * Pure data: per-platform chapter length, default AI-flavor threshold, and
 * prose-style prompt blocks. Word counts are defaults for new projects / when
 * the user did not set a length explicitly — never overwrite an explicit value.
 */

import type { PlatformPreset, PlatformPresetId } from "./types.js";

export const PLATFORM_PRESET_IDS = [
  "qidian",
  "fanqie",
  "jjwxc",
  "qimao",
  "zhihu-short",
] as const satisfies readonly PlatformPresetId[];

export const PLATFORM_PRESET_ALIASES: Readonly<Record<string, PlatformPresetId>> = {
  jinjiang: "jjwxc",
};

export const PLATFORM_PRESETS: Readonly<Record<PlatformPresetId, PlatformPreset>> = {
  qidian: {
    id: "qidian",
    name: "起点（付费连载）",
    chapterWords: { target: 3500, min: 3000, max: 4000 },
    aiFlavorThreshold: 60,
    promptBlock: [
      "【平台写法：起点付费连载】",
      "- 单章 3000-4000 字，一章完成一个小目标；章末给读者\"必须看下一章\"的理由（付费章靠断章拉订阅）",
      "- 可以有稍长的叙述交代设定，但单段不超过 5 行；爽点要有铺垫、有旁人反应、有实际收获",
      "- 升级体系、数值、境界前后严格一致，读者会较真",
    ].join("\n"),
  },
  fanqie: {
    id: "fanqie",
    name: "番茄（免费）",
    chapterWords: { target: 2200, min: 2000, max: 2500 },
    aiFlavorThreshold: 60,
    promptBlock: [
      "【平台写法：番茄免费阅读】",
      "- 单章 2000-2500 字，开头三行内就要有冲突或悬念，节奏比付费文更快",
      "- 段落更短（一两句一段）、对话更多，少设定说明，信息用对话和动作带出",
      "- 每章结尾都要有钩子（免费平台靠章末钩子留人），爽点直给、密度高",
    ].join("\n"),
  },
  jjwxc: {
    id: "jjwxc",
    name: "晋江（女频）",
    chapterWords: { target: 3000, min: 2500, max: 3500 },
    aiFlavorThreshold: 60,
    promptBlock: [
      "【平台写法：晋江女频】",
      "- 情感线是主线：人物关系的细微变化、对话里的潜台词比打斗更重要",
      "- 人物立体，配角有自己的动机；文笔可以细腻一点，但仍是白话，不堆辞藻",
      "- 感情推进有逻辑，误会必须有信息差支撑；章末停在情绪或关系的变化点",
    ].join("\n"),
  },
  qimao: {
    id: "qimao",
    name: "七猫（免费）",
    chapterWords: { target: 2500, min: 2000, max: 3000 },
    aiFlavorThreshold: 60,
    promptBlock: [
      "【平台写法：七猫免费阅读】",
      "- 单章 2000-3000 字，节奏快、爽点直给，开篇三行进冲突",
      "- 语言通俗，段落短，对话推动剧情；少写景、少大段心理独白",
      "- 章末必须留钩子",
    ].join("\n"),
  },
  "zhihu-short": {
    id: "zhihu-short",
    name: "知乎短篇",
    chapterWords: { target: 2800, min: 2200, max: 3500 },
    chapterCount: {
      min: 1,
      max: 1,
      recommendedMin: 1,
      recommendedMax: 1,
      defaultCount: 1,
    },
    aiFlavorThreshold: 55,
    shortForm: "answer",
    promptBlock: [
      "【平台写法：知乎短篇】",
      "- 整篇一篇知乎回答，2200-3500 字（目标约 2800），默认 1 段式，不要输出章节标记",
      "- 开头必须抓人：三行内给出冲突、反差或悬念；若有题目前缀，第一句必须命中",
      "- 全文结尾要有反转或余味，不要写成章末钩子连载",
    ].join("\n"),
  },
};
