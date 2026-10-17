import { describe, expect, it } from "vitest";
import { dragTargetIndex, LAYER_ROW_HEIGHT, nearestVisibleIndex, rowShift } from "./layer-list";

describe("dragTargetIndex", () => {
  it("keeps the layer where it is for a small move", () => {
    expect(dragTargetIndex(2, 5, 0)).toBe(2);
    expect(dragTargetIndex(2, 5, LAYER_ROW_HEIGHT / 2 - 1)).toBe(2);
  });

  it("moves up the list (a higher index) when dragged up", () => {
    expect(dragTargetIndex(1, 5, -LAYER_ROW_HEIGHT)).toBe(2);
    expect(dragTargetIndex(1, 5, -2.6 * LAYER_ROW_HEIGHT)).toBe(4);
  });

  it("moves down the list when dragged down", () => {
    expect(dragTargetIndex(3, 5, LAYER_ROW_HEIGHT)).toBe(2);
  });

  it("clamps to the top and bottom of the list", () => {
    expect(dragTargetIndex(0, 4, -10 * LAYER_ROW_HEIGHT)).toBe(3);
    expect(dragTargetIndex(3, 4, 10 * LAYER_ROW_HEIGHT)).toBe(0);
  });
});

describe("rowShift", () => {
  it("moves the layers the dragged layer passes down one row when it goes up", () => {
    expect(rowShift(1, 1, 3)).toBe(0);
    expect(rowShift(2, 1, 3)).toBe(LAYER_ROW_HEIGHT);
    expect(rowShift(3, 1, 3)).toBe(LAYER_ROW_HEIGHT);
    expect(rowShift(4, 1, 3)).toBe(0);
  });

  it("moves the layers the dragged layer passes up one row when it goes down", () => {
    expect(rowShift(1, 3, 1)).toBe(-LAYER_ROW_HEIGHT);
    expect(rowShift(2, 3, 1)).toBe(-LAYER_ROW_HEIGHT);
    expect(rowShift(3, 3, 1)).toBe(0);
    expect(rowShift(0, 3, 1)).toBe(0);
  });

  it("does not move any row when the layer stays in place", () => {
    expect(rowShift(2, 2, 2)).toBe(0);
  });
});

describe("nearestVisibleIndex", () => {
  it("finds the nearest visible layer, above or below", () => {
    expect(nearestVisibleIndex([true, false, false, true, true], 2)).toBe(3);
    expect(nearestVisibleIndex([true, false, false, false, true], 1)).toBe(0);
  });

  it("prefers the layer above when both are equally near", () => {
    expect(nearestVisibleIndex([true, false, true], 1)).toBe(2);
  });

  it("returns undefined when no other layer is visible", () => {
    expect(nearestVisibleIndex([false, false], 0)).toBeUndefined();
    expect(nearestVisibleIndex([true], 0)).toBeUndefined();
  });
});
