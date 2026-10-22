import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  rangeClientRect,
  visibleOffsetsFromRange,
  type SelectionRect,
} from "../lib/selection-offsets";

export const SELECTION_CHROME_ATTR = "data-selection-chrome";
export const SELECTION_CHROME_SELECTOR = `[${SELECTION_CHROME_ATTR}]`;

export interface TextSelectionState {
  readonly text: string;
  readonly rect: SelectionRect | null;
  readonly range: Range;
  readonly start: number;
  readonly end: number;
}

export interface UseTextSelectionOptions {
  /**
   * Phone / coarse-pointer: keep the last valid snapshot after the live
   * selection collapses until `dismiss()`, so the capsule and compose sheet
   * still have text+offsets.
   */
  readonly sticky?: boolean;
}

export function isSelectionInContainer(
  container: { contains(node: Node): boolean } | null | undefined,
  range: {
    readonly commonAncestorContainer: Node;
    readonly startContainer: Node;
    readonly endContainer: Node;
  } | null | undefined,
): boolean {
  if (!container || !range) return false;
  return (
    container.contains(range.commonAncestorContainer)
    && container.contains(range.startContainer)
    && container.contains(range.endContainer)
  );
}

export function shouldRetainSelection(
  active: Pick<Element, "closest"> | null | undefined,
): boolean {
  return Boolean(active?.closest(SELECTION_CHROME_SELECTOR));
}

export function hasForeignSelection(
  container: { contains(node: Node): boolean } | null | undefined,
  selection: Selection | null | undefined,
): boolean {
  if (!container || !selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  const live = selection.getRangeAt(0);
  if (live.collapsed) return false;
  return !isSelectionInContainer(container, live);
}

/**
 * Decide the next snapshot. Live wins; a non-collapsed range outside the
 * container always clears; otherwise sticky / chrome-retain keep the previous.
 */
export function nextSelectionSnapshot(input: {
  readonly live: TextSelectionState | null;
  readonly previous: TextSelectionState | null;
  readonly sticky: boolean;
  readonly retain: boolean;
  readonly foreign: boolean;
}): TextSelectionState | null {
  if (input.live) return input.live;
  if (input.foreign) return null;
  if (input.retain || input.sticky) return input.previous;
  return null;
}

export function readTextSelection(
  container: Node | null | undefined,
  selection: Selection | null | undefined,
): TextSelectionState | null {
  if (!container || !selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const live = selection.getRangeAt(0);
  if (live.collapsed || !isSelectionInContainer(container, live)) return null;
  const offsets = visibleOffsetsFromRange(container, live);
  if (!offsets) return null;
  return {
    text: offsets.text,
    rect: rangeClientRect(live),
    range: live.cloneRange(),
    start: offsets.start,
    end: offsets.end,
  };
}

/**
 * Track the user's text selection while it stays inside `containerRef`.
 * Collapsed / outside / empty → null on desktop. Focusing `[data-selection-chrome]`
 * keeps the last snapshot. On `sticky`, touchend/mouseup captures a snapshot that
 * survives a later collapsed selection until `dismiss()`.
 */
export function useTextSelection(
  containerRef: RefObject<Element | null>,
  options: UseTextSelectionOptions = {},
): { selection: TextSelectionState | null; dismiss: () => void } {
  const [state, setState] = useState<TextSelectionState | null>(null);
  const stateRef = useRef<TextSelectionState | null>(null);
  const stickyRef = useRef(Boolean(options.sticky));
  stickyRef.current = Boolean(options.sticky);

  const dismiss = useCallback(() => {
    stateRef.current = null;
    setState(null);
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;

    const commit = (next: TextSelectionState | null) => {
      stateRef.current = next;
      setState(next);
    };

    const apply = (live: TextSelectionState | null, retain: boolean, foreign: boolean) => {
      const next = nextSelectionSnapshot({
        live,
        previous: stateRef.current,
        sticky: stickyRef.current,
        retain,
        foreign,
      });
      if (next === stateRef.current) return;
      commit(next);
    };

    const readLive = () => readTextSelection(containerRef.current, window.getSelection());
    const foreignNow = () => hasForeignSelection(containerRef.current, window.getSelection());
    const retainNow = (target?: EventTarget | null) =>
      shouldRetainSelection(document.activeElement)
      || shouldRetainSelection(target as Element | null);

    const update = () => {
      apply(readLive(), retainNow(), foreignNow());
    };

    const capturePointerEnd = (event: Event) => {
      if (retainNow(event.target)) {
        apply(readLive(), true, false);
        return;
      }
      const live = readLive();
      if (live) {
        apply(live, false, false);
        return;
      }
      const recapture = () => {
        const again = readLive();
        if (again) apply(again, false, false);
      };
      requestAnimationFrame(recapture);
      setTimeout(recapture, 0);
    };

    document.addEventListener("selectionchange", update);
    document.addEventListener("mouseup", capturePointerEnd);
    document.addEventListener("touchend", capturePointerEnd);
    return () => {
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("mouseup", capturePointerEnd);
      document.removeEventListener("touchend", capturePointerEnd);
    };
  }, [containerRef]);

  return { selection: state, dismiss };
}
