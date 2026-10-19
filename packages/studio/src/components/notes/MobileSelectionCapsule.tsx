import { cn } from "@/lib/utils";
import { MOBILE_ADD_NOTE_LABEL, MOBILE_SELECTION_CAPSULE_CLASS } from "./selection-ui";

export interface MobileSelectionCapsuleProps {
  readonly onClick: () => void;
  readonly className?: string;
}

export function MobileSelectionCapsule({ onClick, className }: MobileSelectionCapsuleProps) {
  return (
    <button
      type="button"
      data-selection-chrome=""
      data-testid="mobile-selection-capsule"
      className={cn(MOBILE_SELECTION_CAPSULE_CLASS, "select-none", className)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {MOBILE_ADD_NOTE_LABEL}
    </button>
  );
}
