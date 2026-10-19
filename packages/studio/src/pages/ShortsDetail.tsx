import { useEffect, useMemo, useState } from "react";
import { Loader2, ScrollText } from "lucide-react";
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

export function ShortsDetail({ shortId, nav, theme, t }: {
  shortId: string;
  nav: Nav;
  theme: Theme;
  t: TFunction;
}) {
  const c = useColors(theme);
  const { data, refetch, error } = useApi<ShortDetailPayload>(`/shorts/${encodeURIComponent(shortId)}`);
  const [markdown, setMarkdown] = useState("");
  const [answerUrl, setAnswerUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (data?.short) {
      setMarkdown(data.short.markdown);
      setAnswerUrl(data.short.answerUrl ?? "");
    }
  }, [data?.short]);

  const hint = useMemo(() => {
    const bounds = shortCharBounds(data?.short.platform);
    return shortCharHint([...markdown].filter((ch) => !/\s/.test(ch)).length, bounds.min, bounds.max);
  }, [markdown, data?.short.platform]);
  const state = data?.short.reviewState ?? "pending";
  const readOnly = isFinalReadOnly(state);

  async function save() {
    setBusy(true);
    setMessage("");
    try {
      await putApi(`/shorts/${encodeURIComponent(shortId)}/final`, { markdown });
      await refetch();
      setMessage(t("shorts.saved"));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
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
      setMessage(t("shorts.reviewUpdated"));
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
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className={c.link}>{t("bread.home")}</button>
        <span className="text-border">/</span>
        <button onClick={nav.toShorts} className={c.link}>{t("nav.shorts")}</button>
        <span className="text-border">/</span>
        <span className="truncate">{item.title}</span>
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1 space-y-3">
          <h1 className="font-serif text-2xl sm:text-3xl flex items-center gap-3">
            <ScrollText size={26} className="text-primary shrink-0" />
            <span className="truncate">{item.title}</span>
          </h1>
          <div className={`text-sm ${hint.inRange ? "text-muted-foreground" : "text-amber-700"}`}>
            {t("shorts.charHint")}: {hint.label}
          </div>
          <textarea
            value={markdown}
            onChange={(event) => setMarkdown(event.target.value)}
            readOnly={readOnly}
            className="w-full min-h-[50vh] rounded-lg border border-border bg-background p-3 text-sm leading-7 font-mono"
          />
          <div className="flex flex-wrap gap-2">
            <button
              disabled={busy || readOnly}
              onClick={() => void save()}
              className={`px-4 py-2 text-sm rounded-lg ${c.btnPrimary} disabled:opacity-50`}
            >
              {t("common.save")}
            </button>
            {canConfirm(state) && (
              <button disabled={busy} onClick={() => void review("confirmed")} className={`px-4 py-2 text-sm rounded-lg ${c.btnSecondary}`}>
                {t("shorts.confirm")}
              </button>
            )}
            {canReturn(state) && (
              <button disabled={busy} onClick={() => void review("pending")} className={`px-4 py-2 text-sm rounded-lg ${c.btnSecondary}`}>
                {t("shorts.return")}
              </button>
            )}
          </div>
          {canRegisterPublished(state) && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={answerUrl}
                onChange={(event) => setAnswerUrl(event.target.value)}
                placeholder={t("shorts.answerUrl")}
                className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
              <button
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

        <aside className={`w-full lg:w-72 shrink-0 border ${c.cardStatic} rounded-lg p-4 space-y-3 text-sm`}>
          <div><span className="text-muted-foreground">{t("shorts.stateLabel")}</span> {t(`shorts.state.${state}` as never)}</div>
          <div><span className="text-muted-foreground">{t("shorts.batch")}</span> {item.batch ?? "—"}</div>
          <div><span className="text-muted-foreground">{t("shorts.source")}</span> {item.source ?? "—"}</div>
          <div><span className="text-muted-foreground">{t("shorts.platform")}</span> {item.platform ?? "—"}</div>
          <div><span className="text-muted-foreground">{t("shorts.production")}</span> {item.productionStatus ?? "—"}</div>
          <div className="break-all"><span className="text-muted-foreground">{t("shorts.prefix")}</span> {item.review?.titleRequiredPrefix ?? "—"}</div>
          <div className="break-all"><span className="text-muted-foreground">{t("shorts.question")}</span> {item.review?.questionUrl ?? "—"}</div>
          <div className="break-all"><span className="text-muted-foreground">{t("shorts.answerUrl")}</span> {item.answerUrl ?? "—"}</div>
          <div>
            <div className="text-muted-foreground mb-1">{t("shorts.ruleCards")}</div>
            <div className="text-xs leading-6">
              {item.ruleCardIds?.length ? item.ruleCardIds.join(", ") : "—"}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
