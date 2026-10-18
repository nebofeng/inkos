import { useEffect, useState } from "react";
import { isMobileViewport } from "./use-mobile";

/** Align with Tailwind `xl` (min-width: 1280px). Below this, use the 64px rail. */
export const COMPACT_MAX_WIDTH = 1279;
export const COMPACT_QUERY = `(max-width: ${COMPACT_MAX_WIDTH}px)`;

export type StudioLayoutMode = "mobile" | "compact" | "wide";

export function isCompactViewport(win: Pick<Window, "matchMedia"> | undefined = typeof window === "undefined" ? undefined : window): boolean {
  if (!win || typeof win.matchMedia !== "function") return false;
  return win.matchMedia(COMPACT_QUERY).matches;
}

export function deriveStudioLayoutMode(win: Pick<Window, "matchMedia"> | undefined = typeof window === "undefined" ? undefined : window): StudioLayoutMode {
  if (isMobileViewport(win)) return "mobile";
  if (isCompactViewport(win)) return "compact";
  return "wide";
}

export function useLayoutMode(): StudioLayoutMode {
  const [mode, setMode] = useState<StudioLayoutMode>(() => deriveStudioLayoutMode());
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const update = () => setMode(deriveStudioLayoutMode(window));
    const mobile = window.matchMedia("(max-width: 767px)");
    const compact = window.matchMedia(COMPACT_QUERY);
    update();
    mobile.addEventListener("change", update);
    compact.addEventListener("change", update);
    return () => {
      mobile.removeEventListener("change", update);
      compact.removeEventListener("change", update);
    };
  }, []);
  return mode;
}
