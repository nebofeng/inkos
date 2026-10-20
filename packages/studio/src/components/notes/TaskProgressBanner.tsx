import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  CANCEL_CONFIRM_BODY,
  CANCEL_CONFIRM_LABEL,
  CANCEL_CONFIRM_TITLE,
  CANCEL_CONTINUE_LABEL,
  PROGRESS_BANNER_CLASS,
  PROGRESS_BAR_TRACK_CLASS,
  TAP_TARGET_CLASS,
  cancelActionLabel,
  formatProgressCopy,
  type TaskProgressKind,
} from "./note-panel-ui";

const STRIPE_KEYFRAMES = `@keyframes note-progress-stripes {
  from { transform: translateX(0); }
  to { transform: translateX(-50%); }
}`;

export interface TaskProgressBannerProps {
  readonly kind?: TaskProgressKind;
  readonly estimateMs?: number;
  readonly elapsedSeconds: number;
  readonly running?: boolean;
  readonly onCancel: () => void | Promise<void>;
}

export function TaskProgressBanner({
  kind = "note_revise",
  estimateMs,
  elapsedSeconds,
  running = true,
  onCancel,
}: TaskProgressBannerProps) {
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  if (!running && !cancelling) return null;

  const copy = formatProgressCopy({
    kind,
    estimateMs,
    elapsedSeconds,
    cancelling,
  });

  const confirmCancel = async () => {
    setCancelling(true);
    setConfirming(false);
    try {
      await onCancel();
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div
      className={PROGRESS_BANNER_CLASS}
      data-testid="task-progress-banner"
      data-kind={kind}
      aria-busy={running || cancelling}
      role="status"
    >
      <style>{STRIPE_KEYFRAMES}</style>
      {confirming ? (
        <div className="space-y-2">
          <p className="font-medium">{CANCEL_CONFIRM_TITLE}</p>
          <p className="text-indigo-900/80">{CANCEL_CONFIRM_BODY}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className={cn(TAP_TARGET_CLASS, "h-11 md:h-8")}
              onClick={() => setConfirming(false)}
            >
              {CANCEL_CONTINUE_LABEL}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              className={cn(TAP_TARGET_CLASS, "h-11 md:h-8")}
              onClick={() => void confirmCancel()}
            >
              {CANCEL_CONFIRM_LABEL}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-2">
          <p className="leading-5">{copy}</p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={cancelling}
            className={cn(TAP_TARGET_CLASS, "h-11 shrink-0 md:h-8")}
            onClick={() => setConfirming(true)}
          >
            {cancelling ? "正在中止…" : cancelActionLabel(kind)}
          </Button>
        </div>
      )}
      <div className={PROGRESS_BAR_TRACK_CLASS} aria-hidden="true">
        <div
          className="absolute inset-y-0 left-0 h-full w-[200%] rounded-full"
          style={{
            backgroundImage:
              "repeating-linear-gradient(-45deg, rgb(79 70 229 / 0.28) 0 8px, rgb(67 56 202 / 0.8) 8px 16px)",
            animation: "note-progress-stripes 0.85s linear infinite",
          }}
        />
      </div>
    </div>
  );
}
