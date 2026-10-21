import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OPENING_CHECK_DISPLAY_ITEMS } from "./checklist.js";
import type { OpeningCheckItemId } from "./checklist.js";
import type { OpeningCheckReport, OpeningCheckVerdict, OpeningHardGateResult } from "./types.js";

export function openingCheckJsonPath(bookDir: string): string {
  return join(bookDir, "story", "opening-check.json");
}

export function openingCheckMarkdownPath(bookDir: string): string {
  return join(bookDir, "story", "opening-check.md");
}

export function renderOpeningCheckMarkdown(report: OpeningCheckReport): string {
  const lines: string[] = [
    "# 开篇检查",
    "",
    `- 书：${report.bookId}`,
    `- 章节：${report.chapters.length > 0 ? report.chapters.join("、") : "（无）"}`,
    `- 模型：${report.binding.service} / ${report.binding.model}`,
    `- 时间：${report.generatedAt}`,
    "",
  ];
  if (report.skipped) {
    lines.push(`已跳过：${report.skipReason ?? "openingCheck.enabled=false"}`, "");
    if (report.hardGate) lines.push(renderHardGateSection(report.hardGate));
    return `${lines.join("\n")}\n`;
  }
  if (report.hardGate) {
    lines.push(renderHardGateSection(report.hardGate).trimEnd(), "");
  }
  const displayIds = new Set(OPENING_CHECK_DISPLAY_ITEMS.map((item) => String(item.id)));
  for (const item of report.items) {
    if (!displayIds.has(String(item.id))) continue;
    lines.push(`## ${formatItemId(item.id)}. ${item.title} — ${verdictLabel(item.verdict)}`);
    lines.push("");
    lines.push(item.criterion);
    lines.push("");
    if (item.quoteChecks.length > 0) {
      lines.push("原文引用：");
      for (const quote of item.quoteChecks) {
        const mark = quote.verified ? "已核验" : "未核验";
        lines.push(`- （${mark}）${quote.text}`);
      }
      lines.push("");
    }
    if (item.backgroundSpans && item.backgroundSpans.length > 0) {
      lines.push("程序检测（连续无对话叙述 >300 字）：");
      for (const span of item.backgroundSpans) {
        lines.push(`- 第${span.chapterNumber}章 ${span.charCount} 字：${span.excerpt}`);
      }
      lines.push("");
    }
    if (item.suggestion) {
      lines.push(`修改建议：${item.suggestion}`);
      lines.push("");
    }
  }
  const splits = report.items.filter((item) => item.id === "5a" || item.id === "5b");
  if (splits.length > 0) {
    lines.push("## 硬挡拆分（5a / 5b）", "");
    for (const item of splits) {
      lines.push(`- ${formatItemId(item.id)}. ${item.title} — ${verdictLabel(item.verdict)}`);
      if (item.suggestion) lines.push(`  建议：${item.suggestion}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function renderHardGateSection(hardGate: OpeningHardGateResult): string {
  const modeLabel = hardGate.mode === "hard" ? "硬闸" : hardGate.mode === "soft" ? "软闸" : "未启用";
  const lines = [
    "## 硬挡三项",
    "",
    `- 模式：${modeLabel}`,
    `- 结果：${hardGate.passed ? "通过" : "不通过"}`,
  ];
  if (hardGate.reason) lines.push(`- 原因：${hardGate.reason}`);
  lines.push("");
  for (const block of hardGate.blocks) {
    lines.push(`- ${formatItemId(block.id)}. ${block.title} — ${verdictLabel(block.verdict)}`);
    if (block.suggestion) lines.push(`  建议：${block.suggestion}`);
  }
  lines.push("");
  return lines.join("\n");
}

function formatItemId(id: OpeningCheckItemId): string {
  return String(id);
}

function verdictLabel(verdict: OpeningCheckVerdict): string {
  if (verdict === "pass") return "通过";
  if (verdict === "fail") return "不通过";
  return "未核验";
}

export async function writeOpeningCheckReport(
  bookDir: string,
  report: OpeningCheckReport,
): Promise<{ readonly jsonPath: string; readonly mdPath: string }> {
  const jsonPath = openingCheckJsonPath(bookDir);
  const mdPath = openingCheckMarkdownPath(bookDir);
  await mkdir(join(bookDir, "story"), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  await writeFile(mdPath, renderOpeningCheckMarkdown(report), "utf-8");
  return { jsonPath, mdPath };
}

export async function readOpeningCheckReport(bookDir: string): Promise<OpeningCheckReport | undefined> {
  try {
    const raw = await readFile(openingCheckJsonPath(bookDir), "utf-8");
    const parsed = JSON.parse(raw) as OpeningCheckReport;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
