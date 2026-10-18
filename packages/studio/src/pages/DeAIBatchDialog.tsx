import { useEffect, useMemo, useRef, useState } from "react";
import { fetchJson, postApi, useApi } from "../hooks/use-api";
import type { TFunction } from "../hooks/use-i18n";
import type { SSEMessage } from "../hooks/use-sse";
import { ConfirmDialog } from "../components/ConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { skillOptionDisabled, type DeAISkillOption } from "./deai-settings-model";
import {
  deAIBatchPayload,
  deAIJobFromSse,
  deAIProgressPercent,
  deAIResultRows,
  defaultDeAIRange,
  formatDeAIScore,
  lineDiffRows,
  mergeDeAIJob,
  nextPreviewChapter,
  previewChaptersFromJob,
  type DeAIBatchJobView,
  type DeAIBatchMode,
  type DeAIDiffRow,
} from "./deai-batch-model";

interface SkillsResponse {
  readonly skills: ReadonlyArray<DeAISkillOption>;
}

interface PreviewResponse {
  readonly chapter: number;
  readonly original: string;
  readonly preview: string;
}

export function DeAIBatchDialog({
  open,
  bookId,
  chapterNumbers,
  sse,
  t,
  onOpenChange,
  onSettled,
}: {
  readonly open: boolean;
  readonly bookId: string;
  readonly chapterNumbers: readonly number[];
  readonly sse: { readonly messages: ReadonlyArray<SSEMessage> };
  readonly t: TFunction;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSettled?: () => void;
}) {
  const skillsPath = `/deai/skills?bookId=${encodeURIComponent(bookId)}`;
  const { data: skillsData } = useApi<SkillsResponse>(skillsPath);
  const skills = (skillsData?.skills ?? []).filter((skill) => !skill.shadowed);

  const [range, setRange] = useState("");
  const [mode, setMode] = useState<DeAIBatchMode>("score-only");
  const [skill, setSkill] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<DeAIBatchJobView | null>(null);
  const [busy, setBusy] = useState<"start" | "cancel" | number | null>(null);
  const [error, setError] = useState("");
  const [confirmApply, setConfirmApply] = useState(false);
  const [previewChapter, setPreviewChapter] = useState<number | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [decided, setDecided] = useState<Set<number>>(new Set());

  const running = job?.status === "running";
  const wasOpen = useRef(false);

  useEffect(() => {
    const opened = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opened) return;
    setRange(defaultDeAIRange(chapterNumbers));
    setMode("score-only");
    setSkill("");
    setJobId(null);
    setJob(null);
    setBusy(null);
    setError("");
    setConfirmApply(false);
    setPreviewChapter(null);
    setPreview(null);
    setDecided(new Set());
  }, [open, bookId, chapterNumbers]);

  useEffect(() => {
    if (!jobId) return;
    const fromSse = deAIJobFromSse(sse.messages, jobId);
    if (fromSse) setJob((current) => mergeDeAIJob(current, fromSse));
  }, [jobId, sse.messages]);

  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const settledJobRef = useRef<string | null>(null);
  useEffect(() => {
    if (!jobId || !job || job.status === "running") return;
    if (settledJobRef.current === jobId) return;
    settledJobRef.current = jobId;
    onSettledRef.current?.();
  }, [job, jobId]);

  useEffect(() => {
    if (!open || !jobId || job?.status !== "running") return;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await fetchJson<DeAIBatchJobView>(
          `/books/${encodeURIComponent(bookId)}/deai/batch/${encodeURIComponent(jobId)}`,
          {},
          { skipCache: true },
        );
        if (!cancelled) setJob((current) => mergeDeAIJob(current, next));
      } catch {
        // SSE remains the primary progress channel.
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [bookId, job?.status, jobId, open]);

  const rows = useMemo(() => deAIResultRows(job), [job]);
  const previewChapters = useMemo(() => previewChaptersFromJob(job), [job]);
  const percent = deAIProgressPercent(job?.progress);
  const diffRows = useMemo(
    () => (preview ? lineDiffRows(preview.original, preview.preview) : []),
    [preview],
  );

  useEffect(() => {
    if (!job || job.status === "running" || job.mode !== "preview") return;
    if (previewChapter != null) return;
    const next = nextPreviewChapter(previewChapters, null, decided);
    if (next != null) setPreviewChapter(next);
  }, [decided, job, previewChapter, previewChapters]);

  useEffect(() => {
    if (previewChapter == null || !open) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    void fetchJson<PreviewResponse>(
      `/books/${encodeURIComponent(bookId)}/deai/preview/${previewChapter}`,
      {},
      { skipCache: true },
    )
      .then((data) => { if (!cancelled) setPreview(data); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [bookId, open, previewChapter]);

  const close = () => {
    if (running) return;
    onOpenChange(false);
  };

  const start = async (confirmed = false) => {
    if (mode === "apply" && !confirmed) {
      setConfirmApply(true);
      return;
    }
    setError("");
    setBusy("start");
    try {
      const payload = deAIBatchPayload({ range, mode, skill, confirmApply: confirmed });
      const started = await postApi<{ jobId: string }>(`/books/${encodeURIComponent(bookId)}/deai/batch`, payload);
      settledJobRef.current = null;
      setJobId(started.jobId);
      setJob({
        jobId: started.jobId,
        status: "running",
        mode,
        range,
        skill: payload.skill,
        progress: { done: 0, total: 0 },
        chapters: {},
      });
      setPreviewChapter(null);
      setPreview(null);
      setDecided(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const cancelJob = async () => {
    if (!jobId) return;
    setBusy("cancel");
    try {
      await postApi(`/books/${encodeURIComponent(bookId)}/deai/batch/${encodeURIComponent(jobId)}/cancel`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const decidePreview = async (action: "accept" | "reject") => {
    if (previewChapter == null) return;
    const chapter = previewChapter;
    setBusy(chapter);
    setError("");
    try {
      await postApi(`/books/${encodeURIComponent(bookId)}/deai/preview/${chapter}/${action}`);
      const nextDecided = new Set(decided);
      nextDecided.add(chapter);
      setDecided(nextDecided);
      const next = nextPreviewChapter(previewChapters, chapter, nextDecided);
      setPreviewChapter(next);
      setPreview(null);
      onSettled?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => { if (!next) close(); else onOpenChange(true); }}>
        <DialogContent
          className="sm:max-w-4xl max-h-[90vh] overflow-y-auto"
          data-testid="deai-batch-dialog"
          showCloseButton={!running}
        >
          <DialogHeader>
            <DialogTitle>{t("book.deaiBatch")}</DialogTitle>
            <DialogDescription>{t("book.deaiBatchHint")}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-xs text-muted-foreground space-y-1 block">
              <span>{t("book.deaiRange")}</span>
              <input
                data-testid="deai-range"
                value={range}
                onChange={(e) => setRange(e.target.value)}
                disabled={running}
                placeholder="1-20"
                className="w-full rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm outline-none focus:border-primary/50 disabled:opacity-50"
              />
            </label>
            <label className="text-xs text-muted-foreground space-y-1 block">
              <span>{t("book.deaiMode")}</span>
              <select
                data-testid="deai-mode"
                value={mode}
                onChange={(e) => setMode(e.target.value as DeAIBatchMode)}
                disabled={running}
                className="w-full rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm outline-none focus:border-primary/50 disabled:opacity-50"
              >
                <option value="score-only">{t("book.deaiModeScore")}</option>
                <option value="preview">{t("book.deaiModePreview")}</option>
                <option value="apply">{t("book.deaiModeApply")}</option>
              </select>
            </label>
            <label className="text-xs text-muted-foreground space-y-1 block">
              <span>{t("settings.deaiSkill")}</span>
              <select
                data-testid="deai-skill"
                value={skill}
                onChange={(e) => setSkill(e.target.value)}
                disabled={running}
                className="w-full rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm outline-none focus:border-primary/50 disabled:opacity-50"
              >
                <option value="">{t("book.deaiSkillDefault")}</option>
                {skills.map((item) => (
                  <option key={`${item.source}:${item.id}`} value={item.id} disabled={skillOptionDisabled(item)}>
                    {item.id} [{item.source}]{item.valid ? "" : " ✕"}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="deai-batch-start"
              onClick={() => void start(false)}
              disabled={running || busy !== null || !range.trim()}
              className="min-h-11 rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground disabled:opacity-40"
            >
              {t("book.deaiStart")}
            </button>
            {running ? (
              <button
                type="button"
                data-testid="deai-batch-cancel"
                onClick={() => void cancelJob()}
                disabled={busy === "cancel"}
                className="min-h-11 rounded-xl border border-border px-4 py-2 text-sm font-semibold disabled:opacity-40"
              >
                {t("common.cancel")}
              </button>
            ) : (
              <button
                type="button"
                onClick={close}
                className="min-h-11 rounded-xl border border-border px-4 py-2 text-sm font-semibold"
              >
                {t("common.cancel")}
              </button>
            )}
            {job ? (
              <span className="text-xs text-muted-foreground tabular-nums">
                {t("book.deaiProgress")}: {job.progress.done}/{job.progress.total || "?"} ({job.status})
              </span>
            ) : null}
          </div>

          {job ? (
            <div className="space-y-1">
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  data-testid="deai-progress-bar"
                  className="h-full bg-primary transition-all"
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>
          ) : null}

          {error ? <p className="text-xs text-destructive whitespace-pre-wrap">{error}</p> : null}

          {rows.length > 0 ? (
            <div className="overflow-x-auto rounded-xl border border-border/60">
              <table className="w-full text-sm" data-testid="deai-result-table">
                <thead>
                  <tr className="bg-muted/30 text-left text-[11px] uppercase tracking-widest text-muted-foreground">
                    <th className="px-3 py-2">#</th>
                    <th className="px-3 py-2">{t("book.status")}</th>
                    <th className="px-3 py-2">{t("book.deaiScoreBefore")}</th>
                    <th className="px-3 py-2">{t("book.deaiScoreAfter")}</th>
                    <th className="px-3 py-2">{t("book.deaiWritten")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {rows.map((row) => (
                    <tr
                      key={row.chapter}
                      className={previewChapter === row.chapter ? "bg-primary/5" : ""}
                    >
                      <td className="px-3 py-2 font-mono text-xs">
                        {row.written && job?.mode === "preview" ? (
                          <button
                            type="button"
                            className="text-primary hover:underline"
                            onClick={() => setPreviewChapter(row.chapter)}
                          >
                            {row.chapter}
                          </button>
                        ) : row.chapter}
                      </td>
                      <td className="px-3 py-2">{row.status}{row.error ? ` · ${row.error}` : ""}</td>
                      <td className="px-3 py-2 tabular-nums">{formatDeAIScore(row.scoreBefore)}</td>
                      <td className="px-3 py-2 tabular-nums">{formatDeAIScore(row.scoreAfter)}</td>
                      <td className="px-3 py-2">{row.written ? t("common.yes") : t("common.no")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {job?.mode === "preview" && previewChapter != null && preview ? (
            <div className="space-y-2" data-testid="deai-preview-diff">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold">
                  {t("chapter.label").replace("{n}", String(previewChapter))}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    data-testid="deai-accept"
                    onClick={() => void decidePreview("accept")}
                    disabled={busy !== null}
                    className="min-h-11 rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground disabled:opacity-40"
                  >
                    {t("book.deaiAccept")}
                  </button>
                  <button
                    type="button"
                    data-testid="deai-skip"
                    onClick={() => void decidePreview("reject")}
                    disabled={busy !== null}
                    className="min-h-11 rounded-xl border border-border px-4 py-2 text-sm font-semibold disabled:opacity-40"
                  >
                    {t("book.deaiSkip")}
                  </button>
                </div>
              </div>
              <DeAISideBySideDiff rows={diffRows} originalLabel={t("book.deaiOriginal")} previewLabel={t("book.deaiPreview")} />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmApply}
        title={t("book.deaiModeApply")}
        message={t("book.deaiApplyConfirm")}
        confirmLabel={t("book.deaiStart")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onConfirm={() => {
          setConfirmApply(false);
          void start(true);
        }}
        onCancel={() => setConfirmApply(false)}
      />
    </>
  );
}

function DeAISideBySideDiff({
  rows,
  originalLabel,
  previewLabel,
}: {
  readonly rows: ReadonlyArray<DeAIDiffRow>;
  readonly originalLabel: string;
  readonly previewLabel: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 rounded-xl border border-border/60 bg-secondary/10 p-2">
      <p className="px-2 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{originalLabel}</p>
      <p className="px-2 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{previewLabel}</p>
      <div className="max-h-64 overflow-auto rounded-lg bg-background/60 font-mono text-[11px] leading-5">
        {rows.map((row, index) => (
          <div
            key={`l-${index}`}
            className={`whitespace-pre-wrap px-2 ${row.left?.kind === "del" ? "bg-destructive/10 text-destructive" : "text-muted-foreground"}`}
          >
            {row.left?.text ?? " "}
          </div>
        ))}
      </div>
      <div className="max-h-64 overflow-auto rounded-lg bg-background/60 font-mono text-[11px] leading-5">
        {rows.map((row, index) => (
          <div
            key={`r-${index}`}
            className={`whitespace-pre-wrap px-2 ${row.right?.kind === "add" ? "bg-emerald-500/10 text-emerald-700" : "text-muted-foreground"}`}
          >
            {row.right?.text ?? " "}
          </div>
        ))}
      </div>
    </div>
  );
}
