import { Check, MapPin, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ChapterNote } from "@/lib/annotation-client";
import { wordDiff } from "@/lib/note-panel-logic";
import {
  CARD_BASE_CLASS,
  OVERLAP_LABEL,
  TAP_TARGET_CLASS,
  diffTokenClass,
} from "./note-panel-ui";

export interface DiffReviewCardProps {
  readonly note: ChapterNote;
  readonly overlapping?: boolean;
  readonly selected?: boolean;
  readonly highlighted?: boolean;
  readonly disabled?: boolean;
  readonly onToggleSelect?: (note: ChapterNote, selected: boolean) => void;
  readonly onAccept?: (note: ChapterNote) => void;
  readonly onReject?: (note: ChapterNote) => void;
  readonly onLocate?: (note: ChapterNote) => void;
}

export function DiffReviewCard({
  note,
  overlapping = false,
  selected = false,
  highlighted = false,
  disabled = false,
  onToggleSelect,
  onAccept,
  onReject,
  onLocate,
}: DiffReviewCardProps) {
  const original = note.suggestion?.targetText ?? note.selector.exact;
  const suggested = note.suggestion?.replacementText ?? "";
  const tokens = wordDiff(original, suggested);

  return (
    <article
      id={`note-${note.id}`}
      data-testid="diff-review-card"
      data-note-id={note.id}
      data-overlapping={overlapping ? "true" : "false"}
      className={cn(
        CARD_BASE_CLASS,
        overlapping && "border-rose-400 ring-1 ring-rose-300",
        highlighted && "ring-2 ring-indigo-400",
      )}
      onClick={() => onLocate?.(note)}
    >
      <div className="flex items-start justify-between gap-2">
        <label
          className={cn("flex items-center gap-2 text-xs text-zinc-500", TAP_TARGET_CLASS)}
          onClick={(event) => event.stopPropagation()}
        >
          <input
            type="checkbox"
            className="size-4 accent-indigo-600"
            checked={selected}
            disabled={disabled}
            onChange={(event) => onToggleSelect?.(note, event.target.checked)}
          />
          选择
        </label>
        {overlapping ? (
          <Badge variant="destructive" className="bg-rose-100 text-rose-700">
            {OVERLAP_LABEL}
          </Badge>
        ) : (
          <Badge variant="outline" className="bg-indigo-100 text-indigo-800 border-transparent">
            已出建议
          </Badge>
        )}
      </div>

      <p className="mt-2 text-sm text-zinc-800">{note.comment}</p>

      <p className="mt-2 whitespace-pre-wrap leading-7" data-testid="diff-tokens">
        {tokens.map((token, index) => (
          <span key={`${token.type}-${index}`} className={diffTokenClass(token.type)}>
            {token.text}
          </span>
        ))}
      </p>

      <div
        className="mt-3 flex flex-wrap gap-1.5"
        onClick={(event) => event.stopPropagation()}
      >
        <Button
          type="button"
          size="sm"
          disabled={disabled}
          className={cn(TAP_TARGET_CLASS, "h-11 gap-1 md:h-8")}
          onClick={() => onAccept?.(note)}
        >
          <Check className="size-3.5" />
          通过
        </Button>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={disabled}
          className={cn(TAP_TARGET_CLASS, "h-11 gap-1 md:h-8")}
          onClick={() => onReject?.(note)}
        >
          <X className="size-3.5" />
          拒绝
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          className={cn(TAP_TARGET_CLASS, "h-11 gap-1 md:h-8")}
          onClick={() => onLocate?.(note)}
        >
          <MapPin className="size-3.5" />
          定位
        </Button>
      </div>
    </article>
  );
}
