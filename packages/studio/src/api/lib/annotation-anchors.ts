/**
 * W3C Web Annotation-style selectors for chapter notes.
 * Offsets are UTF-16 (JS string indices) into the chapter Markdown source.
 */

export const ANNOTATION_PREFIX_LEN = 32;
export const ANNOTATION_SUFFIX_LEN = 32;
export const ANNOTATION_EXACT_MAX = 500;
export const ANNOTATION_EXACT_MIN = 4;
export const ANNOTATION_FUZZY_THRESHOLD = 0.9;
export const ANNOTATION_FUZZY_MARGIN = 0.08;

export type AnnotationOrigin = "user" | "ai";
export type AnnotationStatus = "open" | "suggested" | "accepted" | "rejected" | "orphaned";

export interface TextQuotePositionSelector {
  readonly exact: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly start: number;
  readonly end: number;
}

export interface RelocateResult {
  readonly status: "located" | "orphaned";
  readonly start?: number;
  readonly end?: number;
  readonly strategy?: "offset" | "exact" | "quote" | "whitespace" | "fuzzy";
}

const SENTENCE_BOUNDARY = /[。！？…!?.]/;

export function hashChapterSource(source: string): string {
  return djb2Hex(source);
}

export function buildSelector(source: string, start: number, end: number): TextQuotePositionSelector {
  const lo = clampIndex(start, source.length);
  const hi = clampIndex(end, source.length);
  if (hi <= lo) {
    throw new Error("Selector range is empty");
  }
  const exact = source.slice(lo, hi);
  if (exact.length > ANNOTATION_EXACT_MAX) {
    throw new Error(`Selector exact text exceeds ${ANNOTATION_EXACT_MAX} characters`);
  }
  return {
    exact,
    prefix: source.slice(Math.max(0, lo - ANNOTATION_PREFIX_LEN), lo),
    suffix: source.slice(hi, Math.min(source.length, hi + ANNOTATION_SUFFIX_LEN)),
    start: lo,
    end: hi,
  };
}

/**
 * Short or ambiguous selections expand to the enclosing sentence.
 * Offsets stay in source Markdown.
 */
export function expandSelectionToSentence(source: string, start: number, end: number): { start: number; end: number } {
  let lo = clampIndex(start, source.length);
  let hi = clampIndex(end, source.length);
  if (hi < lo) {
    const tmp = lo;
    lo = hi;
    hi = tmp;
  }
  while (lo > 0 && !isSentenceStop(source[lo - 1] ?? "")) lo--;
  while (hi < source.length && !isSentenceStop(source[hi - 1] ?? "")) hi++;
  if (hi < source.length && SENTENCE_BOUNDARY.test(source[hi] ?? "")) hi++;
  return { start: lo, end: hi };
}

function isSentenceStop(ch: string): boolean {
  return SENTENCE_BOUNDARY.test(ch) || ch === "\n";
}

export function prepareSourceSelection(source: string, start: number, end: number): TextQuotePositionSelector {
  let range = { start: clampIndex(start, source.length), end: clampIndex(end, source.length) };
  const exact = source.slice(range.start, range.end);
  const unique = countOccurrences(source, exact) === 1;
  if (exact.length < ANNOTATION_EXACT_MIN || !unique) {
    range = expandSelectionToSentence(source, range.start, range.end);
  }
  return buildSelector(source, range.start, range.end);
}

export interface ParagraphAnchor {
  readonly index: number;
  readonly hash: string;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export function splitSourceParagraphs(source: string): ReadonlyArray<{ text: string; start: number; end: number }> {
  const blocks: Array<{ text: string; start: number; end: number }> = [];
  const re = /(?:\r?\n){2,}/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const text = source.slice(last, match.index);
    if (text.length > 0) blocks.push({ text, start: last, end: match.index });
    last = match.index + match[0].length;
  }
  if (last < source.length) blocks.push({ text: source.slice(last), start: last, end: source.length });
  return blocks;
}

export function paragraphAnchorAt(source: string, offset: number): ParagraphAnchor | null {
  const blocks = splitSourceParagraphs(source);
  const index = blocks.findIndex((block) => offset >= block.start && offset <= block.end);
  const block = blocks[index === -1 ? blocks.length - 1 : index];
  if (!block) return null;
  return {
    index: index === -1 ? blocks.length - 1 : index,
    hash: hashChapterSource(block.text),
    text: block.text,
    start: block.start,
    end: block.end,
  };
}

export function relocateParagraphAnchor(
  source: string,
  anchor: Pick<ParagraphAnchor, "index" | "hash">,
): RelocateResult {
  const blocks = splitSourceParagraphs(source);
  const atIndex = blocks[anchor.index];
  if (atIndex && hashChapterSource(atIndex.text) === anchor.hash) {
    return { status: "located", start: atIndex.start, end: atIndex.end, strategy: "offset" };
  }
  const matches = blocks.filter((block) => hashChapterSource(block.text) === anchor.hash);
  if (matches.length === 1) {
    const hit = matches[0]!;
    return { status: "located", start: hit.start, end: hit.end, strategy: "exact" };
  }
  return { status: "orphaned" };
}

export function relocateSelector(
  source: string,
  selector: TextQuotePositionSelector,
  options?: { readonly baseHash?: string; readonly currentHash?: string },
): RelocateResult {
  const exact = selector.exact;
  if (!exact) return { status: "orphaned" };

  const hashUnchanged = Boolean(options?.baseHash) && options?.baseHash === options?.currentHash;
  if (hashUnchanged && offsetsMatch(source, selector)) {
    return { status: "located", start: selector.start, end: selector.end, strategy: "offset" };
  }

  const uniqueExact = uniqueIndexOf(source, exact);
  if (uniqueExact !== null) {
    return { status: "located", start: uniqueExact, end: uniqueExact + exact.length, strategy: "exact" };
  }

  const quoteHit = locateWithAffix(source, exact, selector.prefix, selector.suffix);
  if (quoteHit) {
    return { status: "located", start: quoteHit, end: quoteHit + exact.length, strategy: "quote" };
  }

  const wsHit = locateNormalized(source, exact, selector.prefix, selector.suffix);
  if (wsHit) {
    return { status: "located", start: wsHit.start, end: wsHit.end, strategy: "whitespace" };
  }

  const fuzzy = locateFuzzy(source, exact, selector.prefix, selector.suffix);
  if (fuzzy) {
    return { status: "located", start: fuzzy.start, end: fuzzy.end, strategy: "fuzzy" };
  }

  return { status: "orphaned" };
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function offsetsMatch(source: string, selector: TextQuotePositionSelector): boolean {
  if (
    !Number.isInteger(selector.start)
    || !Number.isInteger(selector.end)
    || selector.start < 0
    || selector.end > source.length
    || selector.end <= selector.start
  ) {
    return false;
  }
  return source.slice(selector.start, selector.end) === selector.exact;
}

function locateWithAffix(source: string, exact: string, prefix: string, suffix: string): number | null {
  const needle = `${prefix}${exact}${suffix}`;
  if (!prefix && !suffix) return null;
  const hits = allIndexesOf(source, needle);
  if (hits.length !== 1) return null;
  return hits[0]! + prefix.length;
}

function locateNormalized(
  source: string,
  exact: string,
  prefix: string,
  suffix: string,
): { start: number; end: number } | null {
  const quoted = locateNormalizedNeedle(source, `${prefix}${exact}${suffix}`);
  if (quoted && prefix) {
    const prefixHit = locateNormalizedNeedle(source.slice(quoted.start, quoted.end), prefix);
    if (prefixHit) {
      const exactStart = quoted.start + prefixHit.end;
      const exactHit = locateNormalizedNeedle(source.slice(exactStart, quoted.end), exact);
      if (exactHit) {
        return { start: exactStart + exactHit.start, end: exactStart + exactHit.end };
      }
    }
  }
  return locateNormalizedNeedle(source, exact);
}

function locateNormalizedNeedle(source: string, needle: string): { start: number; end: number } | null {
  const normalizedNeedle = normalizeWhitespace(needle);
  if (normalizedNeedle.length < ANNOTATION_EXACT_MIN) return null;
  const normalizedSource = normalizeWhitespace(source);
  const first = normalizedSource.indexOf(normalizedNeedle);
  if (first === -1) return null;
  const second = normalizedSource.indexOf(normalizedNeedle, first + normalizedNeedle.length);
  if (second !== -1) return null;
  const start = mapNormalizedToOriginal(source, first);
  const end = mapNormalizedToOriginal(source, first + normalizedNeedle.length);
  if (start < 0 || end < 0 || end <= start) return null;
  return { start, end };
}

function locateFuzzy(
  source: string,
  exact: string,
  prefix: string,
  suffix: string,
): { start: number; end: number } | null {
  if (exact.length < ANNOTATION_EXACT_MIN) return null;
  const seedLen = Math.min(8, exact.length);
  const seed = exact.slice(0, seedLen);
  const candidates: Array<{ start: number; end: number; score: number }> = [];
  for (const index of allIndexesOf(source, seed)) {
    const windowEnd = Math.min(source.length, index + exact.length + Math.ceil(exact.length * 0.2));
    const window = source.slice(index, windowEnd);
    const slice = window.slice(0, exact.length);
    const score = similarity(slice, exact);
    const affixBonus =
      (prefix && source.slice(Math.max(0, index - prefix.length), index) === prefix ? 0.02 : 0)
      + (suffix && source.slice(index + slice.length, index + slice.length + suffix.length) === suffix ? 0.02 : 0);
    candidates.push({ start: index, end: index + slice.length, score: Math.min(1, score + affixBonus) });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0]!;
  const second = candidates[1];
  if (best.score < ANNOTATION_FUZZY_THRESHOLD) return null;
  if (second && best.score - second.score < ANNOTATION_FUZZY_MARGIN) return null;
  return { start: best.start, end: best.end };
}

function uniqueIndexOf(source: string, needle: string): number | null {
  const hits = allIndexesOf(source, needle);
  return hits.length === 1 ? hits[0]! : null;
}

export function countOccurrences(source: string, needle: string): number {
  if (!needle) return 0;
  return allIndexesOf(source, needle).length;
}

function allIndexesOf(source: string, needle: string): number[] {
  if (!needle) return [];
  const hits: number[] = [];
  let from = 0;
  while (from <= source.length - needle.length) {
    const index = source.indexOf(needle, from);
    if (index === -1) break;
    hits.push(index);
    from = index + Math.max(1, needle.length);
  }
  return hits;
}

function mapNormalizedToOriginal(original: string, normalizedPos: number): number {
  let ni = 0;
  let inWhitespace = false;
  let oi = 0;
  while (oi < original.length && /\s/.test(original[oi]!)) oi++;
  if (normalizedPos === 0) return oi;
  for (; oi < original.length && ni < normalizedPos; oi++) {
    const ch = original[oi]!;
    if (/\s/.test(ch)) {
      if (!inWhitespace) {
        ni++;
        inWhitespace = true;
      }
    } else {
      ni++;
      inWhitespace = false;
    }
  }
  return ni >= normalizedPos ? oi : -1;
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j]!;
  }
  return prev[n]!;
}

function clampIndex(value: number, length: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(length, Math.trunc(value)));
}

function djb2Hex(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
