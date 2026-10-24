import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { SelectionRect } from "@/lib/selection-offsets";
import { TAP_TARGET_CLASS } from "./note-panel-ui";
import {
  ADD_NOTE_LABEL,
  ASK_AI_LABEL,
  CANCEL_LABEL,
  DESKTOP_FLOATING_BAR_CLASS,
  NOTE_PLACEHOLDER,
  SAVE_LABEL,
  floatingBarPosition,
  selectionChromePortalTarget,
} from "./selection-ui";

export interface SelectionFloatingBarProps {
  readonly rect: SelectionRect;
  readonly selectedText: string;
  readonly onAddNote: (comment: string) => void;
  readonly onAskAi: (text: string) => void;
  readonly onClose: () => void;
  readonly className?: string;
}

export function SelectionFloatingBar({
  rect,
  selectedText,
  onAddNote,
  onAskAi,
  onClose,
  className,
}: SelectionFloatingBarProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const position = floatingBarPosition(rect);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (composing) {
        setComposing(false);
        setDraft("");
        return;
      }
      onClose();
    };
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [composing, onClose]);

  const save = () => {
    const comment = draft.trim();
    if (!comment) return;
    onAddNote(comment);
    setComposing(false);
    setDraft("");
    onClose();
  };

  const node = (
    <div
      ref={rootRef}
      data-selection-chrome=""
      data-testid="selection-floating-bar"
      role="toolbar"
      aria-label="选区操作"
      className={cn(
        DESKTOP_FLOATING_BAR_CLASS,
        "select-none",
        composing && "flex-col items-stretch gap-2 px-2 py-2",
        className,
      )}
      style={{ left: position.left, top: position.top }}
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).closest("textarea")) return;
        event.preventDefault();
      }}
    >
      {composing ? (
        <>
          <p className="max-w-64 truncate px-0.5 text-[11px] text-zinc-300">{selectedText}</p>
          <Textarea
            value={draft}
            rows={3}
            autoFocus
            placeholder={NOTE_PLACEHOLDER}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-16 w-64 bg-white text-sm text-zinc-900"
          />
          <div className="flex gap-1">
            <Button
              type="button"
              size="sm"
              disabled={!draft.trim()}
              className={cn(TAP_TARGET_CLASS, "h-8")}
              onClick={save}
            >
              {SAVE_LABEL}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={cn(TAP_TARGET_CLASS, "h-8 text-white hover:bg-white/10 hover:text-white")}
              onClick={() => {
                setComposing(false);
                setDraft("");
              }}
            >
              {CANCEL_LABEL}
            </Button>
          </div>
        </>
      ) : (
        <>
          <button
            type="button"
            className="rounded-md px-2.5 py-1 text-xs font-medium hover:bg-white/10"
            onClick={() => setComposing(true)}
          >
            {ADD_NOTE_LABEL}
          </button>
          <button
            type="button"
            className="rounded-md px-2.5 py-1 text-xs font-medium hover:bg-white/10"
            onClick={() => {
              onAskAi(selectedText);
              onClose();
            }}
          >
            {ASK_AI_LABEL}
          </button>
        </>
      )}
    </div>
  );
  const portal = selectionChromePortalTarget() as HTMLElement | null;
  return portal ? createPortal(node, portal) : node;
}
