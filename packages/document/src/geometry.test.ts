import { describe, expect, it } from "vitest";
import {
  EMPTY_RECT,
  intersectRects,
  isEmptyRect,
  isIntegerRect,
  rect,
  rectArea,
  rectContainsPoint,
  rectContainsRect,
  rectFromEdges,
  rectsEqual,
  roundOutRect,
  translateRect,
  unionRects,
} from "./geometry";

describe("geometry", () => {
  it("builds rectangles from edges and empties inverted ones", () => {
    expect(rectFromEdges(1, 2, 4, 6)).toEqual(rect(1, 2, 3, 4));
    expect(isEmptyRect(rectFromEdges(5, 5, 2, 9))).toBe(true);
    expect(isEmptyRect(rect(0, 0, 1, 0))).toBe(true);
    expect(isEmptyRect(rect(0, 0, 1, 1))).toBe(false);
  });

  it("intersects overlapping, touching and disjoint rectangles", () => {
    expect(intersectRects(rect(0, 0, 10, 10), rect(5, -5, 10, 10))).toEqual(rect(5, 0, 5, 5));
    expect(isEmptyRect(intersectRects(rect(0, 0, 10, 10), rect(10, 0, 5, 5)))).toBe(true);
    expect(isEmptyRect(intersectRects(rect(0, 0, 2, 2), rect(50, 50, 2, 2)))).toBe(true);
  });

  it("unions rectangles, ignoring empty ones", () => {
    expect(unionRects(rect(0, 0, 2, 2), rect(5, 5, 1, 1))).toEqual(rect(0, 0, 6, 6));
    expect(unionRects(EMPTY_RECT, rect(3, 3, 1, 1))).toEqual(rect(3, 3, 1, 1));
    expect(unionRects(rect(3, 3, 1, 1), rect(100, 100, 0, 5))).toEqual(rect(3, 3, 1, 1));
    expect(unionRects(EMPTY_RECT, EMPTY_RECT)).toEqual(EMPTY_RECT);
  });

  it("tests containment with exclusive right/bottom edges", () => {
    const r = rect(1, 1, 3, 3);
    expect(rectContainsPoint(r, 1, 1)).toBe(true);
    expect(rectContainsPoint(r, 3, 3)).toBe(true);
    expect(rectContainsPoint(r, 4, 3)).toBe(false);
    expect(rectContainsRect(r, rect(2, 2, 2, 2))).toBe(true);
    expect(rectContainsRect(r, rect(2, 2, 3, 2))).toBe(false);
    expect(rectContainsRect(r, rect(99, 99, 0, 0))).toBe(true);
  });

  it("translates, compares, measures and rounds out", () => {
    expect(translateRect(rect(1, 2, 3, 4), -1, 5)).toEqual(rect(0, 7, 3, 4));
    expect(rectsEqual(rect(1, 2, 3, 4), rect(1, 2, 3, 4))).toBe(true);
    expect(rectsEqual(rect(1, 2, 3, 4), rect(1, 2, 3, 5))).toBe(false);
    expect(rectArea(rect(0, 0, 3, 4))).toBe(12);
    expect(rectArea(rect(0, 0, -3, 4))).toBe(0);
    expect(roundOutRect(rect(0.5, -0.5, 1, 1))).toEqual(rect(0, -1, 2, 2));
    expect(isIntegerRect(rect(0, 0, 1.5, 1))).toBe(false);
  });
});
