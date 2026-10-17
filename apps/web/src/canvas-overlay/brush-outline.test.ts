import { describe, expect, it, vi } from "vitest";
import { paintBrushOutline } from "./draw-overlay";
import { brushOutline, brushOutlineShape } from "./overlay-math";

describe("brushOutline (TL-BRUSH-01)", () => {
  it("draws the tip's radius at the view's zoom, centred on the pointer", () => {
    expect(brushOutline(20, 2, { x: 50, y: 40 })).toEqual({
      x: 50,
      y: 40,
      radius: 20,
      shape: "circle",
    });
    expect(brushOutline(10, 0.5, { x: 3, y: 4 })).toEqual({
      x: 3,
      y: 4,
      radius: 2.5,
      shape: "circle",
    });
  });

  it("follows a square tip with a square outline (owner request)", () => {
    expect(brushOutlineShape("Square")).toBe("square");
    expect(brushOutlineShape("Circle")).toBe("circle");
    expect(brushOutlineShape(undefined)).toBe("circle");
    const outline = brushOutline(20, 2, { x: 50, y: 40 }, "square");
    expect(outline?.shape).toBe("square");
    const calls: string[] = [];
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      stroke: vi.fn(),
      arc: () => calls.push("arc"),
      rect: (x: number, y: number, w: number, h: number) => calls.push(`rect ${x} ${y} ${w} ${h}`),
    } as unknown as CanvasRenderingContext2D;
    if (outline !== undefined) paintBrushOutline(ctx, outline);
    // A light square just outside a dark one, both centred on the pointer; no circle.
    expect(calls).toEqual(["rect 29 19 42 42", "rect 30 20 40 40"]);
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
