import { describe, expect, it } from "vitest";
import {
  buildSelector,
  countOccurrences,
  hashChapterSource,
  paragraphAnchorAt,
  prepareSourceSelection,
  relocateParagraphAnchor,
  relocateSelector,
} from "./annotation-anchors.js";
import {
  mapVisibleRangeToSource,
  simulateChapterReaderVisible,
  simulateStreamdownVisible,
  sourceRangeFromVisibleQuote,
} from "./annotation-selection.js";

const SAMPLE = `# 夜雨

他没说话。

她低声说：“你**必须**走。”

> 「雨还在下。」

第二段里他没说话。门口的灯灭了。
`;

describe("visible-to-source mapping", () => {
  it("maps ChapterReader paragraph text back onto Markdown offsets", () => {
    const index = simulateChapterReaderVisible(SAMPLE);
    const quote = "她低声说：“你**必须**走。”";
    const range = sourceRangeFromVisibleQuote(SAMPLE, index, quote);
    expect(range).not.toBeNull();
    expect(SAMPLE.slice(range!.start, range!.end)).toBe(quote);
  });

  it("maps Streamdown-like visible text (emphasis/heading/quote) back onto source", () => {
    const index = simulateStreamdownVisible(SAMPLE);
    expect(index.visible).toContain("必须");
    expect(index.visible).not.toContain("**");
    expect(index.visible).not.toContain("# ");

    const quote = "你必须走";
    const visStart = index.visible.indexOf(quote);
    expect(visStart).toBeGreaterThan(-1);
    const range = mapVisibleRangeToSource(index, visStart, visStart + quote.length);
    expect(range).not.toBeNull();
    expect(SAMPLE.slice(range!.start, range!.end)).toBe("你**必须**走");
  });

  it("maps a blockquote line without the > marker", () => {
    const index = simulateStreamdownVisible(SAMPLE);
    const quote = "「雨还在下。」";
    const range = sourceRangeFromVisibleQuote(SAMPLE, index, quote);
    expect(range).not.toBeNull();
    expect(SAMPLE.slice(range!.start, range!.end)).toBe(quote);
    expect(SAMPLE.slice(range!.start - 2, range!.start)).toBe("> ");
  });

  it("cannot uniquely map a repeated short visible quote", () => {
    const index = simulateStreamdownVisible(SAMPLE);
    const range = sourceRangeFromVisibleQuote(SAMPLE, index, "他没说话");
    expect(range).toBeNull();
    expect(countOccurrences(SAMPLE, "他没说话")).toBe(2);
  });

  it("expands a short/ambiguous selection to the enclosing sentence", () => {
    const first = SAMPLE.indexOf("他没说话。");
    const selector = prepareSourceSelection(SAMPLE, first, first + 2);
    expect(selector.exact).toContain("他没说话");
    expect(selector.exact.length).toBeGreaterThanOrEqual(4);
    expect(selector.prefix.length).toBeGreaterThan(0);
  });
});

describe("relocateSelector", () => {
  it("uses offsets when the source hash is unchanged", () => {
    const start = SAMPLE.indexOf("门口的灯灭了。");
    const selector = buildSelector(SAMPLE, start, start + "门口的灯灭了。".length);
    const hash = hashChapterSource(SAMPLE);
    const result = relocateSelector(SAMPLE, selector, { baseHash: hash, currentHash: hash });
    expect(result).toMatchObject({ status: "located", strategy: "offset", start, end: start + selector.exact.length });
  });

  it("finds a unique exact quote after an insertion before the span", () => {
    const start = SAMPLE.indexOf("门口的灯灭了。");
    const selector = buildSelector(SAMPLE, start, start + "门口的灯灭了。".length);
    const edited = `前言。\n\n${SAMPLE}`;
    const result = relocateSelector(edited, selector, { baseHash: "old", currentHash: "new" });
    expect(result.status).toBe("located");
    expect(result.strategy).toBe("exact");
    expect(edited.slice(result.start!, result.end!)).toBe("门口的灯灭了。");
  });

  it("disambiguates duplicate exact text with prefix/suffix", () => {
    const first = SAMPLE.indexOf("他没说话。");
    const selector = buildSelector(SAMPLE, first, first + "他没说话。".length);
    expect(countOccurrences(SAMPLE, selector.exact)).toBe(2);
    const edited = SAMPLE.replace("第二段里他没说话。", "第二段里他仍不说话。");
    const result = relocateSelector(edited, selector);
    expect(result.status).toBe("located");
    expect(edited.slice(result.start!, result.end!)).toBe("他没说话。");
    expect(result.start).toBe(edited.indexOf("他没说话。"));
  });

  it("matches after whitespace-only drift", () => {
    const exact = "夜雨\n\n他没说话。";
    const start = SAMPLE.indexOf(exact);
    const selector = buildSelector(SAMPLE, start, start + exact.length);
    const edited = SAMPLE.replace(exact, "夜雨\n\n\n他没说话。");
    const result = relocateSelector(edited, selector, { baseHash: "a", currentHash: "b" });
    expect(result.status).toBe("located");
    expect(result.strategy).toBe("whitespace");
    expect(normalize(edited.slice(result.start!, result.end!))).toBe("夜雨 他没说话。");
  });

  it("marks orphaned when the quote is gone and does not guess", () => {
    const start = SAMPLE.indexOf("门口的灯灭了。");
    const selector = buildSelector(SAMPLE, start, start + "门口的灯灭了。".length);
    const edited = SAMPLE.replace("门口的灯灭了。", "天已经亮了。");
    const result = relocateSelector(edited, selector, { baseHash: "a", currentHash: "b" });
    expect(result).toEqual({ status: "orphaned" });
  });

  it("falls back to paragraph index+hash when quotes collide", () => {
    const first = SAMPLE.indexOf("他没说话。");
    const para = paragraphAnchorAt(SAMPLE, first);
    expect(para).not.toBeNull();
    const moved = `序。\n\n${SAMPLE}`;
    const hit = relocateParagraphAnchor(moved, para!);
    expect(hit.status).toBe("located");
    expect(moved.slice(hit.start!, hit.end!)).toBe(para!.text);
  });
});

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
