import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OpeningCheckReport, OpeningCheckVerdict } from "./types.js";

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
    return `${lines.join("\n")}\n`;
  }
  for (const item of report.items) {
    lines.push(`## ${item.id}. ${item.title} — ${verdictLabel(item.verdict)}`);
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
  return `${lines.join("\n")}\n`;
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
