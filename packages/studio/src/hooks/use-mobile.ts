import { useEffect, useState } from "react";

/** Tailwind `md` breakpoint: below this the layout switches to phone mode. */
export const MOBILE_MAX_WIDTH = 767;
export const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;
/** Touch / stylus: WeChat and some WebViews report a desktop width. */
export const COARSE_POINTER_QUERY = "(pointer: coarse)";

export function isMobileViewport(win: Pick<Window, "matchMedia"> | undefined = typeof window === "undefined" ? undefined : window): boolean {
  if (!win || typeof win.matchMedia !== "function") return false;
  return win.matchMedia(MOBILE_QUERY).matches;
}

export function isCoarsePointer(win: Pick<Window, "matchMedia"> | undefined = typeof window === "undefined" ? undefined : window): boolean {
  if (!win || typeof win.matchMedia !== "function") return false;
  return win.matchMedia(COARSE_POINTER_QUERY).matches;
}

/** Phone width or coarse pointer → bottom capsule, not the desktop floating bar. */
export function usesMobileSelectionChrome(win: Pick<Window, "matchMedia"> | undefined = typeof window === "undefined" ? undefined : window): boolean {
  return isMobileViewport(win) || isCoarsePointer(win);
}

function subscribeQueries(queries: ReadonlyArray<string>, onChange: () => void): () => void {
  const lists = queries.map((query) => window.matchMedia(query));
  for (const list of lists) list.addEventListener("change", onChange);
  return () => {
    for (const list of lists) list.removeEventListener("change", onChange);
  };
}

/** True while the viewport is phone-sized (< md). SSR / tests without matchMedia → false (desktop). */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => isMobileViewport());
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const update = () => setMobile(isMobileViewport(window));
    update();
    return subscribeQueries([MOBILE_QUERY], update);
  }, []);
  return mobile;
}

/** True on phone widths or coarse pointers (capsule path). */
export function useMobileSelectionChrome(): boolean {
  const [uses, setUses] = useState(() => usesMobileSelectionChrome());
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const update = () => setUses(usesMobileSelectionChrome(window));
    update();
    return subscribeQueries([MOBILE_QUERY, COARSE_POINTER_QUERY], update);
  }, []);
  return uses;
}
