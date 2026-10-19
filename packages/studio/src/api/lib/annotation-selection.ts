/**
 * Map a rendered-text selection back onto Markdown source offsets.
 *
 * Two studio renderers exist:
 * - ChapterReader: splits on blank lines and puts raw Markdown in <p>.
 *   Intra-paragraph DOM text === source slice (markers visible).
 * - ShortsDetail Streamdown: markers are not visible; map via a conservative
 *   visible-text index (headings / emphasis / blockquotes / paragraphs).
 *
 * Neither renderer exposes data-src-start/end. Quote matching against source
 * is the source of truth; this module only helps turn a visible range into a
 * candidate source range for selector creation.
 */

export interface VisibleIndex {
  readonly visible: string;
  readonly map: ReadonlyArray<number>;
}

export function chapterReaderBody(source: string): string {
  const lines = source.split("\n");
  const titleLine = lines.find((line) => line.startsWith("# "));
  return lines
    .filter((line) => line !== titleLine)
    .join("\n")
    .trim();
}

/** Visible text as ChapterReader <p> concatenation with a newline between blocks. */
export function simulateChapterReaderVisible(source: string): VisibleIndex {
  const body = chapterReaderBody(source);
  const paragraphs = body.split(/\n\n+/).filter(Boolean);
  let visible = "";
  const map: number[] = [];
  let searchFrom = source.indexOf(body);
  if (searchFrom < 0) searchFrom = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i]!;
    const at = source.indexOf(para, searchFrom);
    if (at < 0) {
      throw new Error("Failed to locate paragraph in source");
    }
    if (i > 0) {
      visible += "\n";
      map.push(at);
    }
    for (let j = 0; j < para.length; j++) {
      visible += para[j]!;
      map.push(at + j);
    }
    searchFrom = at + para.length;
  }
  return { visible, map };
}

/**
 * Conservative CommonMark-ish visible text for Streamdown-like rendering.
 * Tracks source index of every visible character. Not a full parser.
 */
export function simulateStreamdownVisible(source: string): VisibleIndex {
  let visible = "";
  const map: number[] = [];
  let i = 0;
  let lineStart = true;
  const skip = new Set<number>();

  const emit = (sourceIndex: number) => {
    visible += source[sourceIndex]!;
    map.push(sourceIndex);
  };

  while (i < source.length) {
    if (skip.has(i)) {
      i++;
      continue;
    }

    const ch = source[i]!;

    if (lineStart && ch === "#" && (source[i + 1] === "#" || source[i + 1] === " " || source[i + 1] === "\t")) {
      while (i < source.length && source[i] === "#") i++;
      if (source[i] === " " || source[i] === "\t") i++;
      lineStart = false;
      continue;
    }

    if (lineStart && ch === ">") {
      i++;
      if (source[i] === " ") i++;
      lineStart = false;
      continue;
    }

    if (ch === "*" || ch === "_") {
      const marker = peekMarker(source, i);
      if (marker) {
        const close = source.indexOf(marker, i + marker.length);
        if (close > i + marker.length && !source.slice(i + marker.length, close).includes("\n")) {
          for (let k = 0; k < marker.length; k++) {
            skip.add(i + k);
            skip.add(close + k);
          }
          i += marker.length;
          continue;
        }
      }
    }

    emit(i);
    lineStart = ch === "\n";
    i++;
  }

  return { visible, map };
}

export function mapVisibleRangeToSource(
  index: VisibleIndex,
  visibleStart: number,
  visibleEnd: number,
): { start: number; end: number } | null {
  if (visibleStart < 0 || visibleEnd > index.visible.length || visibleEnd <= visibleStart) return null;
  const start = index.map[visibleStart];
  const last = index.map[visibleEnd - 1];
  if (start === undefined || last === undefined) return null;
  return { start, end: last + 1 };
}

export function sourceRangeFromVisibleQuote(
  source: string,
  index: VisibleIndex,
  exact: string,
): { start: number; end: number } | null {
  const at = uniqueIndex(index.visible, exact);
  if (at === null) return null;
  return mapVisibleRangeToSource(index, at, at + exact.length);
}

function uniqueIndex(haystack: string, needle: string): number | null {
  const first = haystack.indexOf(needle);
  if (first === -1) return null;
  const second = haystack.indexOf(needle, first + needle.length);
  return second === -1 ? first : null;
}

function peekMarker(source: string, i: number): string | null {
  if (source.startsWith("**", i) || source.startsWith("__", i)) return source.slice(i, i + 2);
  if (source[i] === "*" || source[i] === "_") return source[i]!;
  return null;
}
