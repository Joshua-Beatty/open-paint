import { SETTING_DEFINITIONS } from "@openpaint/storage";
import { describe, expect, it, vi } from "vitest";
import { paintBrushOutline } from "./draw-overlay";
import { BRUSH_TIP_OUTLINES, brushOutline, brushOutlineShape } from "./overlay-math";

describe("brushOutline (TL-BRUSH-01)", () => {
  it("draws the tip's radius at the view's zoom, centred on the pointer", () => {
    expect(brushOutline(20, 2, { x: 50, y: 40 })).toEqual({
      x: 50,
      y: 40,
      radius: 20,
      shape: "Circle",
    });
    expect(brushOutline(10, 0.5, { x: 3, y: 4 })).toEqual({
      x: 3,
      y: 4,
      radius: 2.5,
      shape: "Circle",
    });
  });

  /** A context that records the path calls a tip outline makes. */
  function recorder() {
    const calls: string[] = [];
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: () => calls.push("begin"),
      stroke: vi.fn(),
      closePath: () => calls.push("close"),
      moveTo: (x: number, y: number) => calls.push(`move ${x} ${y}`),
      lineTo: (x: number, y: number) => calls.push(`line ${x} ${y}`),
      arc: (x: number, y: number, r: number) => calls.push(`arc ${x} ${y} ${r}`),
      rect: (x: number, y: number, w: number, h: number) => calls.push(`rect ${x} ${y} ${w} ${h}`),
    } as unknown as CanvasRenderingContext2D;
    return { ctx, calls };
  }

  it("follows a square tip with a square outline (owner request)", () => {
    expect(brushOutlineShape("Square")).toBe("Square");
    expect(brushOutlineShape("Circle")).toBe("Circle");
    const outline = brushOutline(20, 2, { x: 50, y: 40 }, "Square");
    const { ctx, calls } = recorder();
    if (outline !== undefined) paintBrushOutline(ctx, outline);
    // A light square just outside a dark one, both centred on the pointer; no circle.
    expect(calls).toEqual(["begin", "rect 29 19 42 42", "begin", "rect 30 20 40 40"]);
  });

  it("draws a circle for an unknown or missing tip", () => {
    expect(brushOutlineShape(undefined)).toBe("Circle");
    expect(brushOutlineShape("Star")).toBe("Circle");
    const { ctx, calls } = recorder();
    const outline = brushOutline(4, 1, { x: 10, y: 10 }, "Star");
    if (outline !== undefined) paintBrushOutline(ctx, outline);
    expect(calls.filter((call) => call.startsWith("arc"))).toEqual(["arc 10 10 3", "arc 10 10 2"]);
  });

  it("has an outline for every tip the tip setting offers, so a new tip gets its cursor", () => {
    const tipSetting = SETTING_DEFINITIONS.find((definition) =>
      definition.key.endsWith("brush.type"),
    );
    expect(tipSetting?.choices?.length).toBeGreaterThan(0);
    for (const tip of tipSetting?.choices ?? []) {
      expect(BRUSH_TIP_OUTLINES[tip], tip).toBeDefined();
    }
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
