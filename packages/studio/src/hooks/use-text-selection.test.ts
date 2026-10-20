import { createElement, useEffect } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  SELECTION_CHROME_SELECTOR,
  isSelectionInContainer,
  readTextSelection,
  shouldRetainSelection,
  useTextSelection,
} from "./use-text-selection";

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

describe("readTextSelection", () => {
  it("returns null for missing container, empty selection, or collapsed range", () => {
    expect(readTextSelection(null, null)).toBeNull();
    expect(readTextSelection({} as Node, { rangeCount: 0, isCollapsed: false } as Selection)).toBeNull();
    expect(readTextSelection({} as Node, { rangeCount: 1, isCollapsed: true } as Selection)).toBeNull();
  });
});

describe("useTextSelection", () => {
  it("starts at null during SSR and does not subscribe", () => {
    const spy = vi.fn();
    function Probe() {
      const selection = useTextSelection({ current: null });
      useEffect(() => {
        spy(selection);
      }, [selection]);
      return null;
    }
    renderToString(createElement(Probe));
    expect(spy).not.toHaveBeenCalled();
  });
});
