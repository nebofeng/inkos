import { useEffect, useState } from "react";
import { useChatStore } from "../../store/chat";
import { fetchJson } from "../../hooks/use-api";
import { useIsMobile } from "../../hooks/use-mobile";
import { SidebarCard } from "./SidebarCard";
import { tr } from "../../lib/app-language";
import { cn } from "../../lib/utils";
import {
  ANTAGONIST_ARC_FILE,
  VOLUME_MAP_FILE,
  collapsedRungCount,
  formatVolumeLabel,
  ladderPresence,
  parseOppositionLadder,
  previewLadderRungs,
  type OppositionRung,
} from "../../lib/antagonist-ladder";
import {
  LADDER_COUNTERMOVE,
  LADDER_CRISIS,
  LADDER_EMPTY_CTA,
  LADDER_EMPTY_HINT,
  LADDER_EMPTY_TITLE,
  LADDER_RULE_REWRITE,
  LADDER_SUBTITLE,
  LADDER_TITLE,
  LADDER_UNPLANNED,
  LADDER_VOLUME_MAP_LINK,
  expandRemainingLabel,
} from "./antagonist-ladder-ui";

interface TruthPayload {
  readonly content: string | null;
}

interface AntagonistLadderSectionProps {
  readonly bookId: string;
}

export function AntagonistLadderSection({ bookId }: AntagonistLadderSectionProps) {
  const [rungs, setRungs] = useState<ReadonlyArray<OppositionRung>>([]);
  const [fileFound, setFileFound] = useState(false);
  const [volumeMapFound, setVolumeMapFound] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const openArtifact = useChatStore((s) => s.openArtifact);
  const bookDataVersion = useChatStore((s) => s.bookDataVersion);
  const mobile = useIsMobile();

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setRungs([]);
    setFileFound(false);
    setVolumeMapFound(false);
    setExpanded(false);

    Promise.all([
      fetchJson<TruthPayload>(`/books/${bookId}/truth/${ANTAGONIST_ARC_FILE}`).catch(() => ({ content: null })),
      fetchJson<TruthPayload>(`/books/${bookId}/truth/${VOLUME_MAP_FILE}`).catch(() => ({ content: null })),
    ]).then(([arc, volumeMap]) => {
      if (cancelled) return;
      const raw = arc.content;
      setFileFound(Boolean(raw && raw.trim()));
      setVolumeMapFound(Boolean(volumeMap.content && volumeMap.content.trim()));
      setRungs(parseOppositionLadder(raw));
      setLoaded(true);
    });

    return () => {
      cancelled = true;
    };
  }, [bookId, bookDataVersion]);

  if (!loaded) return null;

  const presence = ladderPresence({ fileFound, volumeMapFound, rungs });
  if (presence === "missing") return null;

  const openVolumeMap = (event?: React.MouseEvent) => {
    event?.stopPropagation();
    openArtifact(VOLUME_MAP_FILE);
  };

  const volumeMapLink = (
    <button
      type="button"
      onClick={openVolumeMap}
      className="text-[13px] leading-5 text-primary hover:underline font-['SimSun','Songti_SC','STSong',serif]"
    >
      {LADDER_VOLUME_MAP_LINK()}
    </button>
  );

  if (presence === "empty") {
    return (
      <SidebarCard
        title={LADDER_TITLE()}
        defaultOpen={false}
        actions={
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-secondary/50 text-muted-foreground font-mono">
            {LADDER_UNPLANNED()}
          </span>
        }
      >
        <p className="text-[13px] leading-5 text-muted-foreground">{LADDER_EMPTY_TITLE()}</p>
        <p className="mt-1 text-[13px] leading-5 text-muted-foreground/80">{LADDER_EMPTY_HINT()}</p>
        <button
          type="button"
          onClick={openVolumeMap}
          className="mt-2 text-[15px] leading-6 text-primary hover:underline font-['SimSun','Songti_SC','STSong',serif]"
        >
          {LADDER_EMPTY_CTA()}
        </button>
      </SidebarCard>
    );
  }

  const visible = previewLadderRungs(rungs, { mobile, expanded });
  const hiddenCount = collapsedRungCount(rungs, { mobile, expanded });

  return (
    <section data-testid="antagonist-ladder" className="rounded-xl border border-border/30">
      <SidebarCard title={LADDER_TITLE()} defaultOpen actions={volumeMapLink}>
        <p className="mb-2 text-[13px] leading-5 text-muted-foreground">{LADDER_SUBTITLE()}</p>
        <ol className="border-l border-border/40 ml-2.5 space-y-1">
          {visible.map((rung, index) => (
            <LadderRow
              key={`${rung.volume}-${rung.opponent}-${index}`}
              rung={rung}
              step={index + 1}
              onOpenVolume={openVolumeMap}
            />
          ))}
        </ol>
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="mt-2 w-full text-left text-[13px] leading-5 text-primary hover:underline"
          >
            {expandRemainingLabel(hiddenCount)}
          </button>
        )}
      </SidebarCard>
    </section>
  );
}

function LadderRow({
  rung,
  step,
  onOpenVolume,
}: {
  readonly rung: OppositionRung;
  readonly step: number;
  readonly onOpenVolume: (event?: React.MouseEvent) => void;
}) {
  const volumeText = formatVolumeLabel(rung.volume || rung.volumeNumber);
  return (
    <li
      className={cn(
        "flex flex-col gap-1 rounded-lg px-2 py-1.5 hover:bg-secondary/20 transition-colors sm:flex-row sm:items-start sm:gap-3",
        rung.finale && "border border-primary/15 bg-primary/5",
      )}
    >
      <div className="flex shrink-0 items-start gap-2 sm:w-[140px]">
        <span
          className={cn(
            "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-mono",
            rung.finale
              ? "border border-primary/20 bg-primary/10 text-primary"
              : "bg-secondary/80 text-muted-foreground",
          )}
        >
          {step}
        </span>
        <div className="min-w-0">
          <button
            type="button"
            onClick={onOpenVolume}
            className="text-[11px] px-1.5 py-0.5 rounded bg-secondary/50 text-muted-foreground font-mono hover:text-foreground"
          >
            {volumeText || tr("卷次", "Vol.")}
          </button>
          {rung.finale && (
            <span className="ml-1 text-[11px] px-1.5 py-0.5 rounded border border-primary/20 text-primary font-mono">
              {LADDER_RULE_REWRITE()}
            </span>
          )}
          <p className="mt-0.5 text-[14px] font-medium text-foreground">{rung.opponent}</p>
        </div>
      </div>
      <p className="min-w-0 flex-1 text-[13px] leading-5 text-muted-foreground">
        <span className="mr-1 text-muted-foreground/70">{LADDER_CRISIS()}</span>
        {rung.crisis}
      </p>
      <p className="min-w-0 flex-1 text-[13px] leading-5 text-muted-foreground">
        <span className="mr-1 text-foreground/80">{LADDER_COUNTERMOVE()}</span>
        {rung.countermove}
      </p>
    </li>
  );
}
