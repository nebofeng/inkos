import { useEffect, useState } from "react";
import { fetchJson, putApi } from "../hooks/use-api";
import type { TFunction } from "../hooks/use-i18n";

interface WritingTemplateView {
  readonly effective?: {
    readonly proseStyle?: string;
    readonly openingStrategy?: string;
    readonly satisfactionTypes?: string[];
    readonly requireGoldenFinger?: boolean;
    readonly goldenFingerSoftGate?: boolean;
  };
  readonly sources?: Record<string, string>;
  readonly hardBlockGoldenFinger?: boolean;
  readonly summary?: string;
  readonly stored?: { readonly book?: Record<string, unknown> | null };
}

const fieldClass = "w-full rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm outline-none focus:border-primary/50";

export function WritingTemplatePanel({
  t,
  bookId,
}: {
  t: TFunction;
  bookId: string;
}) {
  const [view, setView] = useState<WritingTemplateView | null>(null);
  const [proseStyle, setProseStyle] = useState("");
  const [openingStrategy, setOpeningStrategy] = useState("");
  const [softGate, setSoftGate] = useState(false);
  const [requireGf, setRequireGf] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    const data = await fetchJson<WritingTemplateView>(
      `/writing-template?bookId=${encodeURIComponent(bookId)}`,
    );
    setView(data);
    const stored = data.stored?.book ?? {};
    setProseStyle(typeof stored.proseStyle === "string" ? stored.proseStyle : "");
    setOpeningStrategy(typeof stored.openingStrategy === "string" ? stored.openingStrategy : "");
    setSoftGate(stored.goldenFingerSoftGate === true);
    setRequireGf(stored.requireGoldenFinger !== false);
  };

  useEffect(() => {
    void load().catch((error: unknown) => {
      setNotice(error instanceof Error ? error.message : String(error));
    });
  }, [bookId]);

  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      await putApi("/writing-template", {
        scope: "book",
        bookId,
        template: {
          proseStyle: proseStyle.trim() || undefined,
          openingStrategy: openingStrategy.trim() || undefined,
          requireGoldenFinger: requireGf,
          goldenFingerSoftGate: softGate,
        },
      });
      await load();
      setNotice(t("settings.saved"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section data-testid="writing-template-panel" className="space-y-3">
      <div>
        <h3 className="text-sm font-bold">写作模板</h3>
        <p className="text-xs text-muted-foreground">
          生效链：章 → 书 → 项目 → 默认。此处编辑书级；章节覆盖用 CLI。
        </p>
      </div>
      {view?.summary && (
        <p className="font-mono text-[11px] text-muted-foreground break-all">{view.summary}</p>
      )}
      <p className="text-xs">
        金手指硬闸：{view?.hardBlockGoldenFinger ? "开启" : "关闭（软闸/不强制）"}
      </p>
      {view?.sources && (
        <ul className="text-[11px] text-muted-foreground space-y-0.5">
          {Object.entries(view.sources).map(([field, source]) => (
            <li key={field}>{field}: {source}</li>
          ))}
        </ul>
      )}
      <label className="block text-xs font-medium">文风 proseStyle
        <input className={fieldClass} value={proseStyle} onChange={(e) => setProseStyle(e.target.value)} placeholder="现实 procedural" />
      </label>
      <label className="block text-xs font-medium">开篇策略 openingStrategy
        <input className={fieldClass} value={openingStrategy} onChange={(e) => setOpeningStrategy(e.target.value)} placeholder="账本金手指前移" />
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={requireGf} onChange={(e) => setRequireGf(e.target.checked)} />
        强制金手指
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={softGate} onChange={(e) => setSoftGate(e.target.checked)} />
        金手指软闸（司法所等）
      </label>
      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        className="rounded-lg bg-primary px-3 py-2 text-sm font-bold text-primary-foreground disabled:opacity-50"
      >
        {saving ? t("book.saving") : "保存书级模板"}
      </button>
      {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
    </section>
  );
}
