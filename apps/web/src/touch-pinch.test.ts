import { describe, expect, it } from "vitest";
import { pinchCommand, touchSpan } from "./touch-pinch";

describe("touchSpan (WEB-PTR-03)", () => {
  it("takes the midpoint and the distance of two touch points", () => {
    expect(touchSpan({ x: 0, y: 0 }, { x: 30, y: 40 })).toEqual({ x: 15, y: 20, distance: 50 });
  });
});

describe("pinchCommand (WEB-PTR-03)", () => {
  it("zooms by the distance ratio around the old midpoint and pans by its travel", () => {
    const from = touchSpan({ x: 0, y: 0 }, { x: 100, y: 0 });
    const to = touchSpan({ x: 0, y: 10 }, { x: 200, y: 10 });
    expect(pinchCommand(from, to)).toEqual({
      type: "pinch",
      ratio: 2,
      x: 50,
      y: 0,
      dx: 50,
      dy: 10,
    });
  });

  it("gives no step when a span has no distance", () => {
    const apart = touchSpan({ x: 0, y: 0 }, { x: 100, y: 0 });
    const together = touchSpan({ x: 5, y: 5 }, { x: 5, y: 5 });
    expect(pinchCommand(together, apart)).toBeUndefined();
    expect(pinchCommand(apart, together)).toBeUndefined();
  });
});
