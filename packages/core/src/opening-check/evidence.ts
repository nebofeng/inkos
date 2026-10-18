import type { BackgroundSpan, OpeningCheckQuote } from "./types.js";

const PUNCT_RE = /[\s\p{P}\p{S}]/gu;
const DIALOGUE_RE = /“[^”]*”|「[^」]*」|"[^"]*"/;
const SLICE_LEN = 6;
const BACKGROUND_CHAR_LIMIT = 300;

export function stripPunctuation(text: string): string {
  return (text || "").replace(PUNCT_RE, "");
}

export function countVisibleChars(text: string): number {
  return stripWhitespace(text).length;
}

function stripWhitespace(text: string): string {
  return (text || "").replace(/\s+/g, "");
}

/**
 * Quote is valid when the punctuation-stripped string hits the body as a whole,
 * or more than half of its 6-char slices hit (WenlanAI evidence_supported).
 */
export function evidenceSupported(quote: string, body: string): boolean {
  const q = stripPunctuation(quote);
  const b = stripPunctuation(body);
  if (!q || !b) return false;
  if (b.includes(q)) return true;
  if (q.length < SLICE_LEN) return false;
  const slices: string[] = [];
  for (let i = 0; i <= q.length - SLICE_LEN; i++) {
    slices.push(q.slice(i, i + SLICE_LEN));
  }
  if (slices.length === 0) return false;
  const hits = slices.filter((slice) => b.includes(slice)).length;
  return hits * 2 > slices.length;
}

export function verifyQuotes(
  quotes: readonly string[],
  body: string,
): OpeningCheckQuote[] {
  return quotes.map((text) => ({
    text,
    verified: evidenceSupported(text, body),
  }));
}

export function paragraphHasDialogue(paragraph: string): boolean {
  return DIALOGUE_RE.test(paragraph);
}

export function splitNarrativeParagraphs(text: string): string[] {
  return (text || "").split(/\n+/).map((line) => line.trim()).filter((line) => line.length > 0);
}

/**
 * Consecutive no-dialogue narrative longer than 300 visible chars is flagged
 * as pure-background exposition (checklist item 1, deterministic).
 */
export function findBackgroundDumpSpans(
  chapters: ReadonlyArray<{ readonly number: number; readonly body: string }>,
): BackgroundSpan[] {
  const spans: BackgroundSpan[] = [];
  for (const chapter of chapters) {
    const paragraphs = splitNarrativeParagraphs(chapter.body);
    let buf: string[] = [];
    let chars = 0;
    const flush = (): void => {
      if (chars > BACKGROUND_CHAR_LIMIT) {
        const joined = buf.join("");
        spans.push({
          chapterNumber: chapter.number,
          charCount: chars,
          excerpt: joined.length > 240 ? `${joined.slice(0, 240)}…` : joined,
        });
      }
      buf = [];
      chars = 0;
    };
    for (const paragraph of paragraphs) {
      if (paragraphHasDialogue(paragraph)) {
        flush();
        continue;
      }
      buf.push(paragraph);
      chars += countVisibleChars(paragraph);
    }
    flush();
  }
  return spans;
}

export const BACKGROUND_CHAR_LIMIT_VALUE = BACKGROUND_CHAR_LIMIT;
