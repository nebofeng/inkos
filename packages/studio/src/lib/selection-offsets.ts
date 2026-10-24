/**
 * Convert a DOM selection into visible-text offsets inside a container.
 *
 * Offsets are UTF-16 indices into the concatenation of visible text slices
 * (document-order text nodes). The DOM adapter uses Range#toString so start,
 * end, and text stay consistent even when the browser inserts block breaks.
 */

export interface TextSlice {
  readonly text: string;
}

export interface SliceCaret {
  readonly sliceIndex: number;
  readonly offset: number;
}

export interface VisibleOffsets {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface SelectionRect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
  readonly bottom: number;
  readonly right: number;
}

export function concatVisibleText(slices: ReadonlyArray<TextSlice>): string {
  let out = "";
  for (const slice of slices) out += slice.text;
  return out;
}

export function isUsableSelectionText(text: string): boolean {
  return text.trim().length > 0;
}

export function caretToVisibleOffset(
  slices: ReadonlyArray<TextSlice>,
  caret: SliceCaret,
): number | null {
  if (caret.sliceIndex < 0 || caret.sliceIndex >= slices.length) return null;
  const slice = slices[caret.sliceIndex]!;
  if (caret.offset < 0 || caret.offset > slice.text.length) return null;
  let acc = 0;
  for (let i = 0; i < caret.sliceIndex; i++) acc += slices[i]!.text.length;
  return acc + caret.offset;
}

export function visibleOffsetsFromCarets(
  slices: ReadonlyArray<TextSlice>,
  start: SliceCaret,
  end: SliceCaret,
): VisibleOffsets | null {
  const a = caretToVisibleOffset(slices, start);
  const b = caretToVisibleOffset(slices, end);
  if (a == null || b == null) return null;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (hi <= lo) return null;
  const text = concatVisibleText(slices).slice(lo, hi);
  if (!isUsableSelectionText(text)) return null;
  return { start: lo, end: hi, text };
}

export function clientRectToSelectionRect(
  rect: Pick<SelectionRect, "top" | "left" | "width" | "height" | "bottom" | "right">,
): SelectionRect {
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
    bottom: rect.bottom,
    right: rect.right,
  };
}

export function isUsableSelectionRect(
  rect: Pick<SelectionRect, "width" | "height"> | null | undefined,
): boolean {
  return Boolean(rect && rect.width > 0 && rect.height > 0);
}

/**
 * First client rect can be a zero-width ::first-letter leftover (Chrome
 * drop-cap). Skip empty boxes so the desktop bar still has a placeable rect.
 */
export function firstUsableClientRect(
  rects: ArrayLike<Pick<SelectionRect, "top" | "left" | "width" | "height" | "bottom" | "right">>,
): SelectionRect | null {
  for (let i = 0; i < rects.length; i++) {
    const mapped = clientRectToSelectionRect(rects[i]!);
    if (isUsableSelectionRect(mapped)) return mapped;
  }
  return null;
}

export function rangeClientRect(range: Range): SelectionRect | null {
  const fromList = firstUsableClientRect(range.getClientRects());
  if (fromList) return fromList;
  const raw = range.getBoundingClientRect();
  if (!raw) return null;
  const mapped = clientRectToSelectionRect(raw);
  if (!isUsableSelectionRect(mapped)) return null;
  return mapped;
}

/**
 * Visible offsets of `range` inside `container`, using prefix Range#toString.
 * Returns null when the range is collapsed, empty, or not fully contained.
 */
export function visibleOffsetsFromRange(
  container: Node,
  range: AbstractRange,
): VisibleOffsets | null {
  if (!nodeInside(container, range.startContainer) || !nodeInside(container, range.endContainer)) {
    return null;
  }
  const doc = container.ownerDocument;
  if (!doc) return null;
  const prefix = doc.createRange();
  try {
    prefix.selectNodeContents(container);
    prefix.setEnd(range.startContainer, range.startOffset);
  } catch {
    return null;
  }
  const start = prefix.toString().length;
  const text = rangeString(range);
  if (!isUsableSelectionText(text)) return null;
  return { start, end: start + text.length, text };
}

function rangeString(range: AbstractRange): string {
  if (typeof (range as Range).toString === "function") return (range as Range).toString();
  return "";
}

function nodeInside(container: Node, node: Node): boolean {
  return container === node || container.contains(node);
}

