import { useEffect, useId, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TAP_TARGET_CLASS } from "./note-panel-ui";
import {
  CLOSE_LABEL,
  MOBILE_NOTE_SHEET_BODY_CLASS,
  MOBILE_NOTE_SHEET_CLASS,
  MOBILE_NOTE_SHEET_OVERLAY_CLASS,
  keyboardOverlapPx,
} from "./selection-ui";

export interface MobileNoteSheetProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children?: ReactNode;
  readonly className?: string;
}

export function MobileNoteSheet({
  open,
  title,
  onClose,
  children,
  className,
}: MobileNoteSheetProps) {
  const titleId = useId();
  const [keyboardInset, setKeyboardInset] = useState(0);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open || typeof window === "undefined" || !window.visualViewport) {
      setKeyboardInset(0);
      return;
    }
    const visual = window.visualViewport;
    const update = () => setKeyboardInset(keyboardOverlapPx(window, visual));
    update();
    visual.addEventListener("resize", update);
    visual.addEventListener("scroll", update);
    return () => {
      visual.removeEventListener("resize", update);
      visual.removeEventListener("scroll", update);
    };
  }, [open]);

  if (!open) return null;

  return (
    <div data-testid="mobile-note-sheet">
      <div
        data-testid="mobile-note-sheet-overlay"
        className={MOBILE_NOTE_SHEET_OVERLAY_CLASS}
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-selection-chrome=""
        className={cn(MOBILE_NOTE_SHEET_CLASS, className)}
        style={{ bottom: keyboardInset }}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-2 px-4 py-3">
          <h2 id={titleId} className="text-sm font-medium text-zinc-900">
            {title}
          </h2>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={CLOSE_LABEL}
            className={cn(TAP_TARGET_CLASS, "h-11 w-11")}
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </header>
        <div className={MOBILE_NOTE_SHEET_BODY_CLASS}>{children}</div>
      </section>
    </div>
  );
}
