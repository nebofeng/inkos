/**
 * Copy and class names for selection chrome (desktop bar / mobile capsule / sheet).
 */

import type { SelectionRect } from "../../lib/selection-offsets";

export const ADD_NOTE_LABEL = "加备注";
export const ASK_AI_LABEL = "问 AI";
export const SAVE_LABEL = "保存";
export const CANCEL_LABEL = "取消";
export const CLOSE_LABEL = "关闭";
export const MOBILE_ADD_NOTE_LABEL = "✍️ 加备注";
export const NOTE_PLACEHOLDER = "写下修改意见…";
export const FLOATING_BAR_GAP_PX = 8;

/** design.md desktop floating bar; `fixed` + translate-y so `rect` can be viewport-based. */
export const DESKTOP_FLOATING_BAR_CLASS =
  "fixed z-30 flex items-center gap-1 rounded-lg bg-zinc-900 px-1.5 py-1 text-white shadow-xl -translate-x-1/2 -translate-y-full transition-all";

/** design.md mobile 44px capsule, bottom-center. */
export const MOBILE_SELECTION_CAPSULE_CLASS =
  "fixed bottom-6 left-1/2 z-40 flex h-11 items-center gap-2 rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white shadow-2xl -translate-x-1/2 active:scale-95";

export const MOBILE_NOTE_SHEET_OVERLAY_CLASS = "fixed inset-0 z-50 bg-black/40";

export const MOBILE_NOTE_SHEET_CLASS =
  "fixed inset-x-0 bottom-0 z-50 flex h-[50vh] flex-col rounded-t-2xl bg-white shadow-2xl pb-[env(safe-area-inset-bottom)]";

export const MOBILE_NOTE_SHEET_BODY_CLASS = "min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4";

export function floatingBarPosition(
  rect: Pick<SelectionRect, "top" | "left" | "width">,
  gapPx = FLOATING_BAR_GAP_PX,
): { left: number; top: number } {
  return {
    left: rect.left + rect.width / 2,
    top: rect.top - gapPx,
  };
}

/** How much of the layout viewport is covered by the on-screen keyboard. */
export function keyboardOverlapPx(
  view: Pick<Window, "innerHeight">,
  visual: Pick<VisualViewport, "height" | "offsetTop"> | null | undefined,
): number {
  if (!visual) return 0;
  return Math.max(0, view.innerHeight - visual.height - visual.offsetTop);
}
