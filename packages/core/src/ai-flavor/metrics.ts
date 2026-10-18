/**
 * Ported from WenlanAI backend/app/services/ai_flavor_metrics.py
 * (rev 3884ebf1b90922b439ae70004403dfd17a0bd5ca), GPL-3.0;
 * combined into InkOS under AGPL-3.0 (GPL-3.0 §13).
 *
 * Pure function: no model calls. Scoring, word lists, thresholds, and
 * flagged-paragraph rules match the Python original.
 */

export const BOOKISH_WORDS: readonly string[] = [
  "随即", "旋即", "径自", "俨然", "宛如", "恍若", "犹如", "仿佛", "些许", "颇为", "甚是", "略显",
  "须臾", "刹那间", "霎时", "眼眸", "眸中", "眸子", "唇角", "指尖", "发丝", "氤氲", "斑驳", "静谧", "寂寥",
  "黯淡", "心底", "蔓延", "涌起", "泛起", "弥漫", "难以名状", "伫立", "摇曳", "如墨",
];

export const SUMMARY_PHRASES: readonly string[] = [
  "他知道", "她知道", "这一刻", "命运", "信念", "本质", "真理", "无论前方", "一往无前", "道心坚定",
  "艰难险阻", "齿轮", "从未如此", "一丝坚定", "眼神逐渐坚定", "心中暗道", "嘴角勾起一抹",
];

const SENTENCE_SPLIT = /[。！？!?…]+|\n+/;
const QUOTED = /“[^”]*”|「[^」]*」|"[^"]*"/g;
export const LONG_PARAGRAPH = 120;
export const NGRAM = 8;

export interface AiFlavorMetrics {
  readonly chars: number;
  readonly paragraphs: number;
  readonly avgParagraphChars: number;
  readonly longParagraphRatio: number;
  readonly dialogueRatio: number;
  readonly sentenceLenMean: number;
  readonly sentenceLenCv: number;
  readonly bookishPer1k: number;
  readonly summaryPhrases: number;
  readonly repeatRatio: number;
  readonly wordCountRatio: number | null;
  readonly score: number;
  readonly issues: string[];
  readonly flaggedParagraphs: number[];
}

export function splitParagraphs(text: string): string[] {
  return (text || "").split(/\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

export function countLexiconHits(text: string, words: readonly string[]): number {
  let total = 0;
  for (const word of words) {
    if (!word) continue;
    let from = 0;
    while (from <= text.length) {
      const found = text.indexOf(word, from);
      if (found < 0) break;
      total += 1;
      from = found + word.length;
    }
  }
  return total;
}

export function flaggedParagraphIndices(paragraphs: readonly string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i] ?? "";
    const hits = countLexiconHits(paragraph, BOOKISH_WORDS) + countLexiconHits(paragraph, SUMMARY_PHRASES);
    if (hits >= 2 || paragraph.length > LONG_PARAGRAPH * 1.25) {
      out.push(i);
    }
  }
  return out;
}

export function analyzeText(
  text: string,
  previousText = "",
  targetWordCount?: number | null,
): AiFlavorMetrics {
  const source = text || "";
  const chars = source.replace(/\s+/g, "").length;
  const paragraphs = splitParagraphs(source);
  const sentences = splitSentences(source);
  const lengths = sentences.map((sentence) => sentence.length);
  const meanLen = lengths.length > 0 ? mean(lengths) : 0;
  const cv = meanLen && lengths.length > 1 ? pstdev(lengths) / meanLen : 0;
  const quoted = sumQuotedLength(source);
  const dialogueRatio = chars ? quoted / chars : 0;
  const longRatio = paragraphs.length > 0
    ? paragraphs.filter((paragraph) => paragraph.length > LONG_PARAGRAPH).length / paragraphs.length
    : 0;
  const bookish = countLexiconHits(source, BOOKISH_WORDS);
  const bookishPer1k = chars ? (bookish * 1000) / chars : 0;
  const summaryHits = countLexiconHits(source, SUMMARY_PHRASES);
  let repeatRatio = 0;
  if (previousText && chars) {
    const current = ngrams(source);
    const prev = ngrams(previousText);
    repeatRatio = current.size ? intersectionSize(current, prev) / current.size : 0;
  }

  let score = 0;
  const issues: string[] = [];
  if (bookishPer1k > 3) {
    score += Math.min(30, (bookishPer1k - 3) * 4);
    const listed = BOOKISH_WORDS.filter((word) => source.includes(word)).join("、").slice(0, 40);
    issues.push(`书面词偏多（每千字 ${formatFixed(bookishPer1k, 1)} 个，如：${listed}）`);
  }
  if (summaryHits > 1) {
    score += Math.min(25, (summaryHits - 1) * 6);
    issues.push(`总结 / 升华句 ${summaryHits} 处（“他知道”“命运”“一往无前”这类）`);
  }
  if (lengths.length >= 5 && cv < 0.35) {
    score += 15;
    issues.push(`句长太整齐（变异系数 ${formatFixed(cv, 2)}），长短句要错开`);
  }
  if (longRatio > 0.25) {
    score += 10;
    issues.push(`长段落占 ${formatPercent0(longRatio)}，手机阅读要短段`);
  }
  if (chars >= 800 && dialogueRatio < 0.12) {
    score += 10;
    issues.push(`对话只占 ${formatPercent0(dialogueRatio)}，剧情多靠叙述交代`);
  }
  if (repeatRatio > 0.08) {
    score += Math.min(20, repeatRatio * 60);
    issues.push(`与上一章重复片段占 ${formatPercent0(repeatRatio)}，可能在复述前情`);
  }

  return {
    chars,
    paragraphs: paragraphs.length,
    avgParagraphChars: paragraphs.length ? pythonRound(chars / paragraphs.length, 1) : 0,
    longParagraphRatio: pythonRound(longRatio, 3),
    dialogueRatio: pythonRound(dialogueRatio, 3),
    sentenceLenMean: pythonRound(meanLen, 1),
    sentenceLenCv: pythonRound(cv, 3),
    bookishPer1k: pythonRound(bookishPer1k, 2),
    summaryPhrases: summaryHits,
    repeatRatio: pythonRound(repeatRatio, 3),
    wordCountRatio: targetWordCount ? pythonRound(chars / targetWordCount, 3) : null,
    score: Math.min(100, pythonRound(score, 0)),
    issues,
    flaggedParagraphs: flaggedParagraphIndices(paragraphs),
  };
}

export function toSnakeCaseMetrics(metrics: AiFlavorMetrics): Record<string, unknown> {
  return {
    chars: metrics.chars,
    paragraphs: metrics.paragraphs,
    avg_paragraph_chars: metrics.avgParagraphChars,
    long_paragraph_ratio: metrics.longParagraphRatio,
    dialogue_ratio: metrics.dialogueRatio,
    sentence_len_mean: metrics.sentenceLenMean,
    sentence_len_cv: metrics.sentenceLenCv,
    bookish_per_1k: metrics.bookishPer1k,
    summary_phrases: metrics.summaryPhrases,
    repeat_ratio: metrics.repeatRatio,
    word_count_ratio: metrics.wordCountRatio,
    score: metrics.score,
    issues: metrics.issues,
    flagged_paragraphs: metrics.flaggedParagraphs,
  };
}

function splitSentences(text: string): string[] {
  return (text || "").split(SENTENCE_SPLIT).map((part) => part.trim()).filter((part) => part.length >= 2);
}

function sumQuotedLength(text: string): number {
  let total = 0;
  const re = new RegExp(QUOTED.source, "g");
  for (const match of text.matchAll(re)) {
    total += match[0]?.length ?? 0;
  }
  return total;
}

function ngrams(text: string, n = NGRAM): Set<string> {
  const compact = (text || "").replace(/\s+/g, "");
  const out = new Set<string>();
  const last = compact.length - n + 1;
  for (let i = 0; i < last; i++) {
    out.add(compact.slice(i, i + n));
  }
  return out;
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const item of a) {
    if (b.has(item)) n += 1;
  }
  return n;
}

function mean(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

function pstdev(values: readonly number[]): number {
  const m = mean(values);
  let ss = 0;
  for (const value of values) {
    const d = value - m;
    ss += d * d;
  }
  return Math.sqrt(ss / values.length);
}

/** Python 3 round() — half to even. */
export function pythonRound(value: number, digits = 0): number {
  if (!Number.isFinite(value)) return value;
  if (digits === 0) return roundHalfEven(value);
  const factor = 10 ** digits;
  return roundHalfEven(value * factor) / factor;
}

function roundHalfEven(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  const floor = Math.floor(abs);
  const frac = abs - floor;
  let n: number;
  if (frac > 0.5) n = floor + 1;
  else if (frac < 0.5) n = floor;
  else n = floor % 2 === 0 ? floor : floor + 1;
  return sign * n;
}

function formatFixed(value: number, digits: number): string {
  return pythonRound(value, digits).toFixed(digits);
}

function formatPercent0(ratio: number): string {
  return `${pythonRound(ratio * 100, 0)}%`;
}
