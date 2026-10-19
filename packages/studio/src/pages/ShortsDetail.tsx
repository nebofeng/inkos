import { useEffect, useMemo, useState } from "react";
import { BookOpen, Loader2, Pencil, Save, ScrollText, X } from "lucide-react";
import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { postApi, putApi, useApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import {
  canConfirm,
  canRegisterPublished,
  canReturn,
  isFinalReadOnly,
  isValidAnswerUrl,
  shortCharBounds,
  shortCharHint,
} from "./shorts-page-model";
import { ShortsChatRail } from "../components/chat/ShortsChatRail";

const streamdownPlugins = { cjk, code };

interface Nav {
  toDashboard: () => void;
  toShorts: () => void;
}

interface ShortDetailPayload {
  readonly short: {
    readonly id: string;
    readonly title: string;
    readonly batch?: string;
    readonly source?: string;
    readonly platform?: string;
    readonly charCount: number;
    readonly productionStatus?: string;
    readonly reviewState: string;
    readonly answerUrl?: string | null;
    readonly finalPath: string;
    readonly markdown: string;
    readonly ruleCardIds?: ReadonlyArray<string>;
    readonly review?: {
      readonly titleRequiredPrefix?: string;
      readonly questionUrl?: string;
      readonly answerUrl?: string | null;
      readonly state: string;
    };
  };
}

export function ShortsDetail({
  shortId,
  nav,
  theme,
  t,
}: {
  shortId: string;
  nav: Nav;
  theme: Theme;
  t: TFunction;
}) {
  const c = useColors(theme);
  const { data, refetch, error } = useApi<ShortDetailPayload>(`/shorts/${encodeURIComponent(shortId)}`);
  const [markdown, setMarkdown] = useState("");
  const [originalMarkdown, setOriginalMarkdown] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [answerUrl, setAnswerUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (data?.short) {
      setMarkdown(data.short.markdown);
      setOriginalMarkdown(data.short.markdown);
      setAnswerUrl(data.short.answerUrl ?? "");
    }
  }, [data?.short]);

  const bounds = useMemo(() => shortCharBounds(data?.short.platform), [data?.short.platform]);
  const hint = useMemo(() => {
    return shortCharHint([...markdown].filter((ch) => !/\s/.test(ch)).length, bounds.min, bounds.max);
  }, [markdown, bounds]);

  const state = data?.short.reviewState ?? "pending";
  const readOnly = isFinalReadOnly(state);

  async function save() {
    setBusy(true);
    setMessage("");
    try {
      await putApi(`/shorts/${encodeURIComponent(shortId)}/final`, { markdown });
      setOriginalMarkdown(markdown);
      setIsEditing(false);
      await refetch();
      setMessage(t("shorts.saved") ?? "保存成功");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    setMarkdown(originalMarkdown);
    setIsEditing(false);
    setMessage("");
  }

  async function review(to: "pending" | "confirmed" | "published") {
    setBusy(true);
    setMessage("");
    try {
      await postApi(`/shorts/${encodeURIComponent(shortId)}/review`, {
        to,
        ...(to === "published" ? { answerUrl } : {}),
      });
      await refetch();
      setMessage(t("shorts.reviewUpdated") ?? "状态已更新");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!data && !error) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={24} className="animate-spin text-primary" />
      </div>
    );
  }
  if (!data?.short) {
    return <p className="text-sm text-destructive">{t("shorts.missing")}</p>;
  }
  const item = data.short;

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden">
      {/* Main scrollable body */}
      <div className="@container min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-5 space-y-6">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <button onClick={nav.toDashboard} className={c.link}>{t("bread.home")}</button>
          <span className="text-border">/</span>
          <button onClick={nav.toShorts} className={c.link}>{t("nav.shorts")}</button>
          <span className="text-border">/</span>
          <span className="min-w-0 break-words">{item.title}</span>
        </div>

        {/* 按内容区实际宽度并排：@4xl≈896px 才让元信息上侧栏，避免视口 lg 在侧栏+AI 栏挤压后只剩 ~150px。 */}
        <div className="flex flex-col gap-6 @4xl:flex-row @4xl:items-start">
          <div className="min-w-0 flex-1 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <h1 className="min-w-0 flex-1 font-serif text-2xl sm:text-3xl flex items-start gap-3">
                <ScrollText size={26} className="text-primary shrink-0 mt-1" />
                <span data-testid="short-detail-title" className="min-w-0 break-words [overflow-wrap:anywhere]">
                  {item.title}
                </span>
              </h1>

              {/* Mode Toggle Button */}
              {!isEditing ? (
                <button
                  type="button"
                  data-testid="short-edit-btn"
                  disabled={readOnly}
                  onClick={() => setIsEditing(true)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg ${c.btnSecondary} disabled:opacity-40`}
                >
                  <Pencil size={13} />
                  {readOnly ? (t("shorts.publishedReadOnly") ?? "已发布（只读）") : (t("common.edit") ?? "编辑")}
                </button>
              ) : null}
            </div>

            <div
              data-testid="short-char-hint"
              className={`text-sm ${hint.inRange ? "text-muted-foreground" : "text-amber-700 font-medium"}`}
            >
              {t("shorts.charHint")}: {hint.label}
            </div>

            {/* Read mode vs Edit mode */}
            {!isEditing ? (
              <div
                data-testid="short-reader-container"
                className="group relative mx-auto w-full max-w-[72ch] rounded-xl border border-border/40 bg-card/30 p-5 sm:p-7 shadow-xs transition-colors hover:border-border/80"
              >
                <div className="mb-3 flex items-center justify-between border-b border-border/20 pb-2.5 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1.5 font-medium">
                    <BookOpen size={14} className="text-primary" />
                    <span>阅读态</span>
                    {!readOnly && (
                      <span className="text-muted-foreground/60 hidden sm:inline">
                        （点击正文任意位置或上方编辑按钮可进入编辑）
                      </span>
                    )}
                  </div>
                  {readOnly && (
                    <span className="text-[11px] font-semibold text-amber-600 dark:text-amber-400">
                      已发布短篇为只读
                    </span>
                  )}
                </div>

                <article
                  data-testid="short-rendered-content"
                  onClick={() => {
                    if (!readOnly) setIsEditing(true);
                  }}
                  className={`prose prose-neutral dark:prose-invert max-w-[72ch] text-[15px] leading-8 prose-headings:font-semibold prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg prose-p:my-3 prose-li:my-1 prose-pre:whitespace-pre-wrap prose-headings:break-words ${
                    !readOnly ? "cursor-pointer select-text hover:bg-secondary/15 rounded-lg p-2 -m-2 transition-colors" : ""
                  }`}
                >
                  <Streamdown plugins={streamdownPlugins} mode="static">
                    {markdown}
                  </Streamdown>
                </article>
              </div>
            ) : (
              <div className="space-y-3">
                <textarea
                  data-testid="short-editor-textarea"
                  value={markdown}
                  onChange={(event) => setMarkdown(event.target.value)}
                  readOnly={readOnly}
                  className="w-full min-h-[50vh] rounded-xl border border-border bg-background p-4 text-sm leading-7 font-mono focus:outline-none focus:ring-2 focus:ring-primary/20"
                  autoFocus
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="short-save-btn"
                    disabled={busy || readOnly}
                    onClick={() => void save()}
                    className={`flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg ${c.btnPrimary} disabled:opacity-50`}
                  >
                    <Save size={14} />
                    {t("common.save")}
                  </button>
                  <button
                    type="button"
                    data-testid="short-cancel-btn"
                    disabled={busy}
                    onClick={cancel}
                    className={`flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg ${c.btnSecondary}`}
                  >
                    <X size={14} />
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            )}

            {/* Review workflow actions */}
            <div className="flex flex-wrap gap-2 pt-2 border-t border-border/20">
              {canConfirm(state) && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void review("confirmed")}
                  className={`px-4 py-2 text-sm rounded-lg ${c.btnSecondary}`}
                >
                  {t("shorts.confirm")}
                </button>
              )}
              {canReturn(state) && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void review("pending")}
                  className={`px-4 py-2 text-sm rounded-lg ${c.btnSecondary}`}
                >
                  {t("shorts.return")}
                </button>
              )}
            </div>

            {canRegisterPublished(state) && (
              <div className="flex flex-col gap-2 sm:flex-row pt-2">
                <input
                  value={answerUrl}
                  onChange={(event) => setAnswerUrl(event.target.value)}
                  placeholder={t("shorts.answerUrl")}
                  className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm"
                />
                <button
                  type="button"
                  disabled={busy || !isValidAnswerUrl(answerUrl)}
                  onClick={() => void review("published")}
                  className={`px-4 py-2 text-sm rounded-lg ${c.btnPrimary} disabled:opacity-50`}
                >
                  {t("shorts.registerPublished")}
                </button>
              </div>
            )}

            {message && <p className="text-sm text-muted-foreground">{message}</p>}
          </div>

          <aside
            data-testid="short-meta-card"
            className={`w-full min-w-0 @4xl:w-72 @4xl:shrink-0 border ${c.cardStatic} rounded-xl p-4 text-sm shadow-xs`}
          >
            <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 @4xl:grid-cols-1 @4xl:space-y-1">
              <div><span className="text-muted-foreground">{t("shorts.stateLabel")}</span> {t(`shorts.state.${state}` as never)}</div>
              <div><span className="text-muted-foreground">{t("shorts.batch")}</span> {item.batch ?? "—"}</div>
              <div><span className="text-muted-foreground">{t("shorts.source")}</span> {item.source ?? "—"}</div>
              <div><span className="text-muted-foreground">{t("shorts.platform")}</span> {item.platform ?? "—"}</div>
              <div><span className="text-muted-foreground">{t("shorts.production")}</span> {item.productionStatus ?? "—"}</div>
              <div className="break-all"><span className="text-muted-foreground">{t("shorts.prefix")}</span> {item.review?.titleRequiredPrefix ?? "—"}</div>
              <div className="break-all sm:col-span-2 @4xl:col-span-1"><span className="text-muted-foreground">{t("shorts.question")}</span> {item.review?.questionUrl ?? "—"}</div>
              <div className="break-all sm:col-span-2 @4xl:col-span-1"><span className="text-muted-foreground">{t("shorts.answerUrl")}</span> {item.answerUrl ?? "—"}</div>
              <div className="sm:col-span-2 @4xl:col-span-1">
                <div className="text-muted-foreground mb-1">{t("shorts.ruleCards")}</div>
                <div className="text-xs leading-6 break-words">
                  {item.ruleCardIds?.length ? item.ruleCardIds.join(", ") : "—"}
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>

      {/* Right AI Chat Rail */}
      <ShortsChatRail
        shortId={shortId}
        title={item.title}
        markdown={markdown}
        platform={item.platform}
        charBounds={bounds}
        readOnly={readOnly}
        onApplyMarkdown={async (newMarkdown: string) => {
          setBusy(true);
          try {
            await putApi(`/shorts/${encodeURIComponent(shortId)}/final`, { markdown: newMarkdown });
            setMarkdown(newMarkdown);
            setOriginalMarkdown(newMarkdown);
            setIsEditing(false);
            await refetch();
            setMessage(t("shorts.saved") ?? "保存成功");
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}
