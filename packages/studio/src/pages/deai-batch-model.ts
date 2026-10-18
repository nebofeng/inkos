export type DeAIBatchMode = "score-only" | "preview" | "apply";
export type DeAIBadgeTone = "ok" | "warn" | "fail" | "muted";

export interface DeAISkillOption {
  readonly id: string;
  readonly source: string;
  readonly valid: boolean;
  readonly errors?: ReadonlyArray<{ readonly message?: string }>;
  readonly shadowed?: boolean;
}

export interface DeAIChapterRecordView {
  readonly chapterNumber: number;
  readonly score: number | null;
  readonly status: string;
}

export interface DeAIBatchChapterView {
  readonly status: string;
  readonly scoreBefore: number | null;
  readonly scoreAfter: number | null;
  readonly written: boolean;
  readonly error?: string;
}

export interface DeAIBatchRowView {
  readonly chapter: number;
  readonly status: string;
  readonly scoreBefore: number | null;
  readonly scoreAfter: number | null;
  readonly written: boolean;
  readonly error?: string;
}

export interface DeAIBatchJobView {
  readonly jobId: string;
  readonly bookId?: string;
  readonly status: "running" | "completed" | "cancelled" | "error";
  readonly mode: DeAIBatchMode | string;
  readonly range?: string;
  readonly skill?: string;
  readonly error?: string;
  readonly progress: { done: number; total: number; current?: number };
  readonly chapters: Record<string, DeAIBatchChapterView>;
  readonly report?: { readonly rows: ReadonlyArray<DeAIBatchRowView>; readonly stoppedReason?: string };
}

export interface DeAIDiffLine {
  readonly kind: "same" | "del" | "add";
  readonly text: string;
}

export interface DeAIDiffRow {
  readonly left?: { readonly text: string; readonly kind: "same" | "del" };
  readonly right?: { readonly text: string; readonly kind: "same" | "add" };
}

export interface DeAIChapterBadgeView {
  readonly score: number | null;
  readonly status: string;
  readonly tone: DeAIBadgeTone;
}

export const DEAI_BADGE_TONE_CLASS: Record<DeAIBadgeTone, string> = {
  ok: "bg-emerald-500/10 text-emerald-600",
  warn: "bg-amber-500/10 text-amber-600",
  fail: "bg-destructive/10 text-destructive",
  muted: "bg-muted/40 text-muted-foreground",
};

export function defaultDeAIRange(chapterNumbers: readonly number[]): string {
  if (chapterNumbers.length === 0) return "";
  const sorted = [...new Set(chapterNumbers.filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (last - first + 1 === sorted.length) return `${first}-${last}`;
  return "all";
}

export function deAIProgressPercent(progress: { readonly done: number; readonly total: number } | undefined): number {
  if (!progress || progress.total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((progress.done / progress.total) * 100)));
}

export function deAIBatchPayload(input: {
  readonly range: string;
  readonly mode: DeAIBatchMode;
  readonly skill?: string;
  readonly confirmApply?: boolean;
}): { range: string; mode: DeAIBatchMode; skill?: string; confirm?: true } {
  const range = input.range.trim();
  const body: { range: string; mode: DeAIBatchMode; skill?: string; confirm?: true } = {
    range,
    mode: input.mode,
  };
  const skill = input.skill?.trim();
  if (skill) body.skill = skill;
  if (input.mode === "apply") {
    if (input.confirmApply !== true) {
      throw new Error("apply requires confirm");
    }
    body.confirm = true;
  }
  return body;
}

export function deAIJobFromSse(
  messages: ReadonlyArray<{ readonly event: string; readonly data: unknown }>,
  jobId: string,
): DeAIBatchJobView | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.event !== "deai:progress") continue;
    const data = message.data as DeAIBatchJobView | null;
    if (data && data.jobId === jobId) return data;
  }
  return null;
}

export function mergeDeAIJob(
  current: DeAIBatchJobView | null,
  incoming: DeAIBatchJobView | null,
): DeAIBatchJobView | null {
  if (!incoming) return current;
  if (!current || current.jobId !== incoming.jobId) return incoming;
  return {
    ...current,
    ...incoming,
    progress: incoming.progress ?? current.progress,
    chapters: incoming.chapters ?? current.chapters,
    report: incoming.report ?? current.report,
  };
}

export function deAIResultRows(job: DeAIBatchJobView | null): DeAIBatchRowView[] {
  if (!job) return [];
  if (job.report?.rows?.length) return [...job.report.rows];
  return Object.entries(job.chapters ?? {})
    .map(([key, value]) => ({
      chapter: Number(key),
      status: value.status,
      scoreBefore: value.scoreBefore,
      scoreAfter: value.scoreAfter,
      written: value.written,
      error: value.error,
    }))
    .filter((row) => Number.isInteger(row.chapter) && row.chapter > 0)
    .sort((a, b) => a.chapter - b.chapter);
}

export function previewChaptersFromJob(job: DeAIBatchJobView | null): number[] {
  if (!job || job.mode !== "preview") return [];
  return deAIResultRows(job).filter((row) => row.written).map((row) => row.chapter);
}

export function nextPreviewChapter(chapters: readonly number[], current: number | null, decided: ReadonlySet<number>): number | null {
  const remaining = chapters.filter((n) => !decided.has(n));
  if (remaining.length === 0) return null;
  if (current == null) return remaining[0] ?? null;
  const after = remaining.find((n) => n > current);
  return after ?? remaining[0] ?? null;
}

export function lineDiff(before: string, after: string): DeAIDiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 80_000) {
    return naiveLineDiff(a, b);
  }
  const m = a.length;
  const n = b.length;
  const dp: Int32Array[] = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = 1; i <= m; i++) {
    const ai = a[i - 1];
    const row = dp[i]!;
    const prev = dp[i - 1]!;
    for (let j = 1; j <= n; j++) {
      row[j] = ai === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, row[j - 1]!);
    }
  }
  const rev: DeAIDiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      rev.push({ kind: "same", text: a[i - 1]! });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || (dp[i]![j - 1]! >= dp[i - 1]![j]!))) {
      rev.push({ kind: "add", text: b[j - 1]! });
      j -= 1;
    } else {
      rev.push({ kind: "del", text: a[i - 1]! });
      i -= 1;
    }
  }
  return rev.reverse();
}

function naiveLineDiff(a: readonly string[], b: readonly string[]): DeAIDiffLine[] {
  const max = Math.max(a.length, b.length);
  const out: DeAIDiffLine[] = [];
  for (let i = 0; i < max; i++) {
    const left = a[i];
    const right = b[i];
    if (left === right) out.push({ kind: "same", text: left ?? "" });
    else {
      if (left !== undefined) out.push({ kind: "del", text: left });
      if (right !== undefined) out.push({ kind: "add", text: right });
    }
  }
  return out;
}

export function lineDiffRows(before: string, after: string): DeAIDiffRow[] {
  const lines = lineDiff(before, after);
  const rows: DeAIDiffRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i]!;
    if (cur.kind === "same") {
      rows.push({
        left: { text: cur.text, kind: "same" },
        right: { text: cur.text, kind: "same" },
      });
      continue;
    }
    if (cur.kind === "del") {
      const next = lines[i + 1];
      if (next?.kind === "add") {
        rows.push({
          left: { text: cur.text, kind: "del" },
          right: { text: next.text, kind: "add" },
        });
        i += 1;
      } else {
        rows.push({ left: { text: cur.text, kind: "del" } });
      }
      continue;
    }
    rows.push({ right: { text: cur.text, kind: "add" } });
  }
  return rows;
}

export function deAIChapterBadge(
  record: { readonly score?: number | null; readonly status?: string } | undefined,
): DeAIChapterBadgeView | null {
  if (!record) return null;
  const status = record.status?.trim() ?? "";
  const score = typeof record.score === "number" && Number.isFinite(record.score) ? Math.round(record.score) : null;
  if (score == null && !status) return null;
  const tone: DeAIBadgeTone = status === "failed"
    ? "fail"
    : status === "warned" || status === "warn"
      ? "warn"
      : status === "ok"
        ? "ok"
        : "muted";
  return { score, status: status || "unknown", tone };
}

export function compactDeAISuffix(
  record: { readonly score?: number | null; readonly status?: string } | undefined,
): string {
  const badge = deAIChapterBadge(record);
  if (!badge) return "";
  const score = badge.score == null ? "" : String(badge.score);
  if (badge.tone === "fail") return score ? ` ·deAI${score}!` : " ·deAI!";
  if (badge.tone === "warn") return score ? ` ·deAI${score}~` : " ·deAI~";
  return score ? ` ·deAI${score}` : " ·deAI";
}

export function recordMapFromList(
  records: ReadonlyArray<DeAIChapterRecordView> | undefined,
): Map<number, DeAIChapterRecordView> {
  const map = new Map<number, DeAIChapterRecordView>();
  for (const record of records ?? []) {
    if (!Number.isInteger(record.chapterNumber) || record.chapterNumber < 1) continue;
    map.set(record.chapterNumber, record);
  }
  return map;
}

export function mergeDeAIRecords(
  persisted: ReadonlyArray<{ readonly chapterNumber: number; readonly score?: number; readonly status?: string }> | undefined,
  batchChapters: Record<string, DeAIBatchChapterView> | undefined,
): DeAIChapterRecordView[] {
  const map = new Map<number, DeAIChapterRecordView>();
  for (const [key, value] of Object.entries(batchChapters ?? {})) {
    const chapterNumber = Number(key);
    if (!Number.isInteger(chapterNumber) || chapterNumber < 1) continue;
    map.set(chapterNumber, {
      chapterNumber,
      score: value.scoreAfter ?? value.scoreBefore,
      status: value.status,
    });
  }
  for (const record of persisted ?? []) {
    if (!Number.isInteger(record.chapterNumber) || record.chapterNumber < 1) continue;
    map.set(record.chapterNumber, {
      chapterNumber: record.chapterNumber,
      score: typeof record.score === "number" ? record.score : null,
      status: record.status ?? "unknown",
    });
  }
  return [...map.values()].sort((a, b) => a.chapterNumber - b.chapterNumber);
}

export function formatDeAIScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return String(Math.round(value));
}
