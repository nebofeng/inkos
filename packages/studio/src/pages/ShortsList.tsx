import { useMemo, useState } from "react";
import { Loader2, ScrollText } from "lucide-react";
import { useApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { filterShorts, shortCharHint, type ShortFilter, type ShortListRow } from "./shorts-page-model";

interface Nav {
  toDashboard: () => void;
  toShort: (id: string) => void;
}

const FILTERS: ShortFilter[] = ["all", "pending", "confirmed", "published"];

function badgeClass(state: string): string {
  if (state === "published") return "bg-emerald-500/10 text-emerald-600";
  if (state === "confirmed") return "bg-sky-500/10 text-sky-600";
  return "bg-amber-500/10 text-amber-700";
}

export function ShortsList({ nav, theme, t }: { nav: Nav; theme: Theme; t: TFunction }) {
  const c = useColors(theme);
  const { data, refetch } = useApi<{ shorts: ShortListRow[] }>("/shorts");
  const [filter, setFilter] = useState<ShortFilter>("all");
  const [query, setQuery] = useState("");
  const items = useMemo(
    () => filterShorts(data?.shorts ?? [], filter, query),
    [data?.shorts, filter, query],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className={c.link}>{t("bread.home")}</button>
        <span className="text-border">/</span>
        <span>{t("nav.shorts")}</span>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-serif text-3xl flex items-center gap-3">
          <ScrollText size={28} className="text-primary" />
          {t("shorts.title")}
        </h1>
        <button onClick={() => refetch()} className={`px-4 py-2 text-sm rounded-lg ${c.btnSecondary}`}>
          {t("common.refresh")}
        </button>
      </div>

      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("shorts.search")}
          className="w-full md:max-w-sm rounded-lg border border-border bg-background px-3 py-2 text-sm"
        />
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((item) => (
            <button
              key={item}
              onClick={() => setFilter(item)}
              className={`px-3 py-1.5 text-xs rounded-full border ${filter === item ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}
            >
              {t(`shorts.filter.${item}` as never)}
            </button>
          ))}
        </div>
      </div>

      {!data ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={24} className="animate-spin text-primary" />
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("shorts.empty")}</p>
      ) : (
        <div className="grid gap-3">
          {items.map((item) => {
            const hint = shortCharHint(item.charCount);
            return (
              <button
                key={item.id}
                onClick={() => nav.toShort(item.id)}
                className={`text-left border ${c.cardStatic} rounded-lg p-4 hover:border-primary/40 transition-colors`}
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{item.title}</div>
                    <div className="mt-1 text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-1">
                      <span>{item.id}</span>
                      {item.batch && <span>{t("shorts.batch")}: {item.batch}</span>}
                      {item.source && <span>{t("shorts.source")}: {item.source}</span>}
                      {item.productionStatus && <span>{t("shorts.production")}: {item.productionStatus}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${hint.inRange ? "text-muted-foreground" : "text-amber-700"}`}>
                      {hint.label}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${badgeClass(item.reviewState)}`}>
                      {t(`shorts.state.${item.reviewState}` as never)}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
