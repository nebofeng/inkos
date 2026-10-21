import { OPENING_CHECK_ITEMS, OPENING_CHECK_OUTPUT_FORMAT } from "./checklist.js";
import type { OpeningCheckChapter } from "./types.js";
import {
  formatWritingTemplateContext,
  resolveEffectiveWritingTemplate,
  shouldHardBlockGoldenFinger,
  type WritingTemplateFields,
} from "../models/writing-template.js";

export const OPENING_CHECK_SYSTEM_PROMPT = [
  "你是网文开篇审核员。只根据给定正文做清单判定，不要编造没写出来的情节。",
  "必须只输出一个 JSON 对象，不要 markdown 围栏，不要前后说明。",
  "JSON 形状：{\"items\":[{\"id\":1,\"verdict\":\"pass\",\"quotes\":[\"从正文逐字摘录的原句\"],\"suggestion\":\"\"}]}",
  "verdict 只能是 pass 或 fail。每条都要有 id。必须包含 1–8，以及硬挡拆分 5a、5b。",
  "5a=金手指（给出选择并与眼前屈辱挂钩）；5b=黄金500字内出现钩子（能力预兆或金手指入口）。二者必须分开判定：可以有金手指但 5b fail，也可以 5b 有场面钩但 5a 无金手指。",
  "id 5 是金手指总条，应与 5a+5b 一致：任一 fail 则 5 fail。id 7 是当面小 boss。",
  "quotes 必须是正文里真实出现的连续片段；找不到证据就 fail 并建议怎么补。",
  "suggestion 用中文，具体到改哪一场、加哪句对话。pass 时 suggestion 可为空字符串。",
].join("");

export function buildOpeningCheckUserPrompt(
  chapters: readonly OpeningCheckChapter[],
  writingTemplateSummary?: string,
): string {
  const checklist = OPENING_CHECK_ITEMS
    .map((item) => `${item.id}. ${item.title}：${item.criterion}`)
    .join("\n");
  const bodies = chapters
    .map((chapter) => `## 第${chapter.number}章\n${chapter.body.trim()}`)
    .join("\n\n");
  return [
    "请审核这本书前三章（不足三章则审现有章节），逐条对照清单。",
    writingTemplateSummary ? `\n${writingTemplateSummary}\n` : "",
    "【清单】",
    checklist,
    "硬挡三项必须分开给 verdict：5a 金手指、5b 黄金500字钩、7 当面小boss。",
    `输出要求：${OPENING_CHECK_OUTPUT_FORMAT}。只输出 JSON。`,
    "",
    "【正文】",
    bodies,
  ].filter((line) => line !== "").join("\n");
}

/**
 * RD-049 hook helper: format the effective template for opening-check context.
 * Does not implement the hard gate. Callers should use shouldHardBlockGoldenFinger.
 */
export function openingCheckWritingTemplateHook(input: {
  readonly chapter?: WritingTemplateFields;
  readonly book?: WritingTemplateFields;
  readonly project?: WritingTemplateFields;
}): {
  readonly summary: string;
  readonly hardBlockGoldenFinger: boolean;
} {
  const resolved = resolveEffectiveWritingTemplate(input);
  return {
    summary: formatWritingTemplateContext(resolved),
    hardBlockGoldenFinger: shouldHardBlockGoldenFinger(resolved.effective),
  };
}
