import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import {
  MOBILE_ADD_NOTE_LABEL,
  MOBILE_SELECTION_CAPSULE_CLASS,
  selectionChromePortalTarget,
} from "./selection-ui";

export interface MobileSelectionCapsuleProps {
  readonly onClick: () => void;
  readonly className?: string;
}

function retainSelection(event: { preventDefault(): void }) {
  event.preventDefault();
}

export function MobileSelectionCapsule({ onClick, className }: MobileSelectionCapsuleProps) {
  const node = (
    <button
      type="button"
      data-selection-chrome=""
      data-testid="mobile-selection-capsule"
      className={cn(MOBILE_SELECTION_CAPSULE_CLASS, "select-none", className)}
      onPointerDown={retainSelection}
      onTouchStart={retainSelection}
      onMouseDown={retainSelection}
      onClick={onClick}
    >
      {MOBILE_ADD_NOTE_LABEL}
    </button>
  );
  const portal = selectionChromePortalTarget() as HTMLElement | null;
  return portal ? createPortal(node, portal) : node;
}
