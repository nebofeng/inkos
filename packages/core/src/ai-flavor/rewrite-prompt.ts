/**
 * Ported from WenlanAI backend/app/services/deai_rewrite.py
 * (rev 3884ebf1b90922b439ae70004403dfd17a0bd5ca), GPL-3.0;
 * combined into InkOS under AGPL-3.0 (GPL-3.0 §13).
 */

export const OUTPUT_RULES = "直接输出改写后的完整正文：不要章节标题，不要任何说明、注释或前后缀。";
export const LOCAL_OUTPUT_RULES = "输出格式：每个待改写段落一行，以「[P编号]」开头，后接改写后的整段；只输出这些行，不要任何说明。";
export const GLOSSARY_LIMIT = 80;
const LOCAL_LINE = /^\s*\[P(\d+)\]\s*(.+?)\s*$/;

export const DEFAULT_DEAI_PROMPTS: readonly string[] = [
  "去掉书面词、总结升华句和机械解释，改成大白话、短句、具体动作。保持原意、人物、事件、信息量不变，不要新增情节，不要和上下文重复。",
];

export function cleanPrompts(promptTexts: Iterable<string>): string[] {
  const texts = [...promptTexts].map((text) => text.trim()).filter((text) => text.length > 0);
  if (texts.length === 0) {
    throw new Error("至少需要一条去 AI 味提示词");
  }
  return texts;
}

export function glossaryBlock(glossary?: Iterable<string> | null): string {
  const names = uniqueTrimmed(glossary).slice(0, GLOSSARY_LIMIT);
  if (names.length === 0) return "";
  return `【专有名词（人名 / 地名 / 势力 / 功法 / 物品，原样保留，不得改写或替换）】\n${names.join("、")}`;
}

export function buildRewritePrompt(
  promptTexts: readonly string[],
  content: string,
  glossary?: Iterable<string> | null,
): string {
  const texts = cleanPrompts(promptTexts);
  const body = (content || "").trim();
  if (!body) throw new Error("章节正文为空，无法重写");
  const glossaryText = glossaryBlock(glossary);
  const head = glossaryText ? [...texts, glossaryText].join("\n\n") : texts.join("\n\n");
  return `${head}\n\n【原文】\n${body}\n\n${OUTPUT_RULES}`;
}

export function splitParagraphLines(text: string): { lines: string[]; paraLines: number[] } {
  const lines = (text || "").split("\n");
  const paraLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").trim()) paraLines.push(i);
  }
  return { lines, paraLines };
}

export function buildLocalRewritePrompt(
  promptTexts: readonly string[],
  paragraphs: readonly string[],
  targets: readonly number[],
  glossary?: Iterable<string> | null,
): string {
  const texts = cleanPrompts(promptTexts);
  const uniqueTargets = [...new Set(targets.filter((i) => i >= 0 && i < paragraphs.length))].sort((a, b) => a - b);
  if (uniqueTargets.length === 0) throw new Error("没有需要局部重写的段落");
  const context = [...new Set(
    uniqueTargets.flatMap((i) => [i - 1, i + 1]).filter((j) => j >= 0 && j < paragraphs.length && !uniqueTargets.includes(j)),
  )].sort((a, b) => a - b);

  const parts = [...texts];
  const glossaryText = glossaryBlock(glossary);
  if (glossaryText) parts.push(glossaryText);
  parts.push(
    `下面是本章里 AI 味较重的 ${uniqueTargets.length} 个段落（编号 = 段落序号）。只改写这些段落：保持原意、人物、事件、信息量不变，`
    + "长度相近，换成大白话、短句、具体动作；不要新增情节，不要和上下文重复。",
  );
  parts.push(`【待改写段落】\n${uniqueTargets.map((i) => `[P${i + 1}] ${paragraphs[i]!.trim()}`).join("\n")}`);
  if (context.length > 0) {
    parts.push(`【上下文段落（只读，用来衔接，不要改写、不要输出）】\n${context.map((j) => `P${j + 1}：${paragraphs[j]!.trim()}`).join("\n")}`);
  }
  parts.push(LOCAL_OUTPUT_RULES);
  return parts.join("\n\n");
}

export function parseLocalRewrite(text: string, targets: readonly number[]): Map<number, string> {
  const wanted = new Set(targets);
  const out = new Map<number, string>();
  for (const line of (text || "").split(/\n/)) {
    const match = LOCAL_LINE.exec(line);
    if (!match) continue;
    const index = Number(match[1]) - 1;
    const body = (match[2] ?? "").trim();
    if (wanted.has(index) && body) out.set(index, body);
  }
  return out;
}

export function mergeParagraphs(text: string, replacements: ReadonlyMap<number, string> | Record<number, string>): string {
  const { lines, paraLines } = splitParagraphLines(text);
  const entries = replacements instanceof Map
    ? replacements.entries()
    : Object.entries(replacements).map(([key, value]) => [Number(key), value] as const);
  for (const [index, newText] of entries) {
    if (index >= 0 && index < paraLines.length) {
      lines[paraLines[index]!] = newText;
    }
  }
  return lines.join("\n");
}

function uniqueTrimmed(values?: Iterable<string> | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const name = value.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
