import { createElement, useEffect } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  SELECTION_CHROME_SELECTOR,
  hasForeignSelection,
  isSelectionInContainer,
  nextSelectionSnapshot,
  readTextSelection,
  shouldRetainSelection,
  useTextSelection,
  type TextSelectionState,
} from "./use-text-selection";

const SNAPSHOT: TextSelectionState = {
  text: "门口的灯灭了。",
  rect: null,
  range: {} as Range,
  start: 0,
  end: 7,
};

describe("isSelectionInContainer", () => {
  const inside = { id: "in" } as unknown as Node;
  const outside = { id: "out" } as unknown as Node;
  const container = {
    contains(node: Node) {
      return node === inside;
    },
  };

  it("requires the whole range to sit inside the container", () => {
    expect(
      isSelectionInContainer(container, {
        commonAncestorContainer: inside,
        startContainer: inside,
        endContainer: inside,
      }),
    ).toBe(true);
    expect(
      isSelectionInContainer(container, {
        commonAncestorContainer: outside,
        startContainer: inside,
        endContainer: outside,
      }),
    ).toBe(false);
  });

  it("is false without a container or range", () => {
    expect(isSelectionInContainer(null, null)).toBe(false);
    expect(isSelectionInContainer(container, null)).toBe(false);
  });
});

describe("shouldRetainSelection", () => {
  it("keeps the snapshot while selection chrome is focused", () => {
    expect(SELECTION_CHROME_SELECTOR).toBe("[data-selection-chrome]");
    expect(
      shouldRetainSelection({
        closest: (selector: string) => (selector === SELECTION_CHROME_SELECTOR ? ({} as Element) : null),
      }),
    ).toBe(true);
    expect(shouldRetainSelection({ closest: () => null })).toBe(false);
    expect(shouldRetainSelection(null)).toBe(false);
  });
});

describe("hasForeignSelection", () => {
  const inside = { id: "in" } as unknown as Node;
  const outside = { id: "out" } as unknown as Node;
  const container = {
    contains(node: Node) {
      return node === inside;
    },
  };

  it("is true only for a non-collapsed range outside the container", () => {
    const foreign = {
      rangeCount: 1,
      isCollapsed: false,
      getRangeAt: () => ({
        collapsed: false,
        commonAncestorContainer: outside,
        startContainer: outside,
        endContainer: outside,
      }),
    } as unknown as Selection;
    expect(hasForeignSelection(container, foreign)).toBe(true);
    expect(hasForeignSelection(container, { rangeCount: 0, isCollapsed: false } as Selection)).toBe(false);
    expect(hasForeignSelection(container, { rangeCount: 1, isCollapsed: true } as Selection)).toBe(false);
  });
});

describe("nextSelectionSnapshot", () => {
  it("prefers a live snapshot", () => {
    const live = { ...SNAPSHOT, text: "新选区" };
    expect(nextSelectionSnapshot({
      live,
      previous: SNAPSHOT,
      sticky: true,
      retain: false,
      foreign: false,
    })).toBe(live);
  });

  it("clears on a foreign selection even when sticky", () => {
    expect(nextSelectionSnapshot({
      live: null,
      previous: SNAPSHOT,
      sticky: true,
      retain: true,
      foreign: true,
    })).toBeNull();
  });

  it("keeps the previous snapshot while sticky after collapse", () => {
    expect(nextSelectionSnapshot({
      live: null,
      previous: SNAPSHOT,
      sticky: true,
      retain: false,
      foreign: false,
    })).toBe(SNAPSHOT);
  });

  it("keeps the previous snapshot while chrome retains on desktop", () => {
    expect(nextSelectionSnapshot({
      live: null,
      previous: SNAPSHOT,
      sticky: false,
      retain: true,
      foreign: false,
    })).toBe(SNAPSHOT);
  });

  it("clears on desktop when the live selection collapses", () => {
    expect(nextSelectionSnapshot({
      live: null,
      previous: SNAPSHOT,
      sticky: false,
      retain: false,
      foreign: false,
    })).toBeNull();
  });
});

describe("readTextSelection", () => {
  it("returns null for missing container, empty selection, or collapsed range", () => {
    expect(readTextSelection(null, null)).toBeNull();
    expect(readTextSelection({} as Node, { rangeCount: 0, isCollapsed: false } as Selection)).toBeNull();
    expect(readTextSelection({} as Node, { rangeCount: 1, isCollapsed: true } as Selection)).toBeNull();
  });

  it("keeps text+offsets when the range has no usable client rect", () => {
    const text = "门口的灯灭了。";
    const node = { nodeType: 3, textContent: text } as unknown as Text;
    const container = {
      contains: (candidate: Node) => candidate === node,
      ownerDocument: {
        createRange: () => ({
          selectNodeContents() {},
          setEnd() {},
          toString: () => "",
        }),
      },
    } as unknown as Node;
    const live = {
      collapsed: false,
      commonAncestorContainer: node,
      startContainer: node,
      endContainer: node,
      startOffset: 0,
      endOffset: text.length,
      cloneRange() { return this; },
      toString: () => text,
      getClientRects: () => [],
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
    };
    const selection = {
      rangeCount: 1,
      isCollapsed: false,
      getRangeAt: () => live,
    } as unknown as Selection;

    const result = readTextSelection(container, selection);
    expect(result).toEqual({
      text,
      rect: null,
      range: live,
      start: 0,
      end: text.length,
    });
  });
});

describe("useTextSelection", () => {
  it("starts at null during SSR and does not subscribe", () => {
    const spy = vi.fn();
    function Probe() {
      const { selection } = useTextSelection({ current: null });
      useEffect(() => {
        spy(selection);
      }, [selection]);
      return null;
    }
    renderToString(createElement(Probe));
    expect(spy).not.toHaveBeenCalled();
  });
});
