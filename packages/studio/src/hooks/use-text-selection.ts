import { useEffect, useState, type RefObject } from "react";
import {
  rangeClientRect,
  visibleOffsetsFromRange,
  type SelectionRect,
} from "../lib/selection-offsets";

export const SELECTION_CHROME_ATTR = "data-selection-chrome";
export const SELECTION_CHROME_SELECTOR = `[${SELECTION_CHROME_ATTR}]`;

export interface TextSelectionState {
  readonly text: string;
  readonly rect: SelectionRect;
  readonly range: Range;
  readonly start: number;
  readonly end: number;
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

export function readTextSelection(
  container: Node | null | undefined,
  selection: Selection | null | undefined,
): TextSelectionState | null {
  if (!container || !selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const live = selection.getRangeAt(0);
  if (live.collapsed || !isSelectionInContainer(container, live)) return null;
  const offsets = visibleOffsetsFromRange(container, live);
  if (!offsets) return null;
  const rect = rangeClientRect(live);
  if (!rect) return null;
  return {
    text: offsets.text,
    rect,
    range: live.cloneRange(),
    start: offsets.start,
    end: offsets.end,
  };
}

/**
 * Track the user's text selection while it stays inside `containerRef`.
 * Collapsed / outside / empty → null. Focusing `[data-selection-chrome]`
 * (floating bar / capsule) keeps the last snapshot so the UI can accept input.
 */
export function useTextSelection(
  containerRef: RefObject<Element | null>,
): TextSelectionState | null {
  const [state, setState] = useState<TextSelectionState | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;

    const update = () => {
      const next = readTextSelection(containerRef.current, window.getSelection());
      if (next) {
        setState(next);
        return;
      }
      if (shouldRetainSelection(document.activeElement)) return;
      setState(null);
    };

    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, [containerRef]);

  return state;
}
