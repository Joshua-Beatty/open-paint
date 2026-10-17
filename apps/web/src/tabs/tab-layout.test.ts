import { describe, expect, it } from "vitest";
import {
  dropIndex,
  overflowEdges,
  revealScrollLeft,
  slideOffset,
  wheelScrollPx,
} from "./tab-layout";

describe("wheelScrollPx", () => {
  it("scrolls by pixels along the larger axis", () => {
    expect(wheelScrollPx({ deltaX: 0, deltaY: 100, deltaMode: 0 }, 500)).toBe(100);
    expect(wheelScrollPx({ deltaX: -40, deltaY: 10, deltaMode: 0 }, 500)).toBe(-40);
  });

  it("turns lines (Firefox mouse wheels) and pages into pixels", () => {
    expect(wheelScrollPx({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 500)).toBeCloseTo(100);
    expect(wheelScrollPx({ deltaX: 0, deltaY: -1, deltaMode: 2 }, 500)).toBe(-500);
  });
});

describe("overflowEdges", () => {
  it("is not scrollable when the tabs fit", () => {
    expect(overflowEdges({ scrollLeft: 0, clientWidth: 300, scrollWidth: 300 })).toEqual({
      scrollable: false,
      atStart: true,
      atEnd: true,
    });
  });

  it("reports both edges while scrolled to the middle", () => {
    expect(overflowEdges({ scrollLeft: 100, clientWidth: 300, scrollWidth: 700 })).toEqual({
      scrollable: true,
      atStart: false,
      atEnd: false,
    });
  });

  it("reports the start and end of the scroll range", () => {
    expect(overflowEdges({ scrollLeft: 0, clientWidth: 300, scrollWidth: 700 }).atStart).toBe(true);
    expect(overflowEdges({ scrollLeft: 400, clientWidth: 300, scrollWidth: 700 }).atEnd).toBe(true);
  });

  it("tolerates sub-pixel scroll positions", () => {
    expect(overflowEdges({ scrollLeft: 0.4, clientWidth: 300, scrollWidth: 700 }).atStart).toBe(
      true,
    );
  });
});

describe("revealScrollLeft", () => {
  const view = { scrollLeft: 100, clientWidth: 200 };

  it("keeps the scroll position when the tab is already fully visible", () => {
    expect(revealScrollLeft(view, { left: 150, width: 50 })).toBe(100);
  });

  it("scrolls left so a tab hidden on the left is at the edge", () => {
    expect(revealScrollLeft(view, { left: 40, width: 50 })).toBe(40);
  });

  it("scrolls right so a tab hidden on the right ends at the edge", () => {
    expect(revealScrollLeft(view, { left: 260, width: 50 })).toBe(110);
  });
});

describe("dropIndex", () => {
  // Three tabs of width 100 at 0, 100 and 200. Their midpoints are 50, 150 and 250.
  const slots = [
    { left: 0, width: 100 },
    { left: 100, width: 100 },
    { left: 200, width: 100 },
  ];

  it("keeps a tab where it is while its center stays near its slot", () => {
    expect(dropIndex(0, 50, slots)).toBe(0);
  });

  it("moves a tab right past the midpoints it crosses", () => {
    expect(dropIndex(0, 160, slots)).toBe(1);
    expect(dropIndex(0, 260, slots)).toBe(2);
  });

  it("moves a tab left past the midpoints it crosses", () => {
    expect(dropIndex(2, 140, slots)).toBe(1);
    expect(dropIndex(2, 40, slots)).toBe(0);
  });
});

describe("slideOffset", () => {
  it("makes the tabs between the old and new positions step aside", () => {
    expect(slideOffset(1, 0, 2, 120)).toBe(-120);
    expect(slideOffset(2, 0, 2, 120)).toBe(-120);
    expect(slideOffset(0, 0, 2, 120)).toBe(0);
    expect(slideOffset(3, 0, 2, 120)).toBe(0);
  });

  it("moves the tabs back the other way when dragging left", () => {
    expect(slideOffset(0, 2, 0, 120)).toBe(120);
    expect(slideOffset(1, 2, 0, 120)).toBe(120);
    expect(slideOffset(2, 2, 0, 120)).toBe(0);
  });

  it("leaves every tab in place when the tab has not moved", () => {
    expect(slideOffset(1, 1, 1, 120)).toBe(0);
  });
});
