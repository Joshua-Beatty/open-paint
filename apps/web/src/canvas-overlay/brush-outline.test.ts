import { describe, expect, it } from "vitest";
import { brushOutline } from "./overlay-math";

describe("brushOutline (TL-BRUSH-01)", () => {
  it("draws the tip's radius at the view's zoom, centred on the pointer", () => {
    expect(brushOutline(20, 2, { x: 50, y: 40 })).toEqual({ x: 50, y: 40, radius: 20 });
    expect(brushOutline(10, 0.5, { x: 3, y: 4 })).toEqual({ x: 3, y: 4, radius: 2.5 });
  });

  it("keeps a visible ring for a tip that would be thinner than a device pixel", () => {
    expect(brushOutline(1, 0.25, { x: 0, y: 0 })?.radius).toBe(1);
  });

  it("draws nothing without a tip or a view", () => {
    expect(brushOutline(0, 1, { x: 0, y: 0 })).toBeUndefined();
    expect(brushOutline(Number.NaN, 1, { x: 0, y: 0 })).toBeUndefined();
    expect(brushOutline(4, 0, { x: 0, y: 0 })).toBeUndefined();
  });
});
