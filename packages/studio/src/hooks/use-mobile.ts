import { useEffect, useState } from "react";

/** Tailwind `md` breakpoint: below this the layout switches to phone mode. */
export const MOBILE_MAX_WIDTH = 767;
export const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;

export function isMobileViewport(win: Pick<Window, "matchMedia"> | undefined = typeof window === "undefined" ? undefined : window): boolean {
  if (!win || typeof win.matchMedia !== "function") return false;
  return win.matchMedia(MOBILE_QUERY).matches;
}

/** True while the viewport is phone-sized (< md). SSR / tests without matchMedia → false (desktop). */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => isMobileViewport());
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(MOBILE_QUERY);
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return mobile;
}
