/**
 * Desktop sidebar widths.
 *
 * Do not combine `xl:w-[240px]` with `min-[1680px]:w-[280px]`: both match at
 * ≥1680 and Tailwind stylesheet source order can let 240 win (no extra
 * specificity). Use exclusive queries instead:
 * 1280–1679 = 240; ≥1680 (incl. 1920) = 280. <1280 stays rail / drawer.
 */
export const SIDEBAR_DESKTOP_WIDTH_CLASS =
  "xl:max-[1679px]:w-[240px] min-[1680px]:w-[280px]";
