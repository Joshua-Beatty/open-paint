import { describe, expect, it } from "vitest";
import { paintTransformFrame, type TransformFrameSpots } from "./draw-overlay";

/** A 2D context that records the paths it strokes and the rectangles it fills. */
function recorder() {
  const calls: string[] = [];
  const ctx = {
    save: () => undefined,
    restore: () => undefined,
    beginPath: () => calls.push("beginPath"),
    closePath: () => calls.push("closePath"),
    moveTo: (x: number, y: number) => calls.push(`moveTo ${x},${y}`),
    lineTo: (x: number, y: number) => calls.push(`lineTo ${x},${y}`),
    arc: () => calls.push("arc"),
    stroke: () => calls.push("stroke"),
    fill: () => calls.push("fill"),
    fillRect: () => calls.push("fillRect"),
    strokeRect: () => calls.push("strokeRect"),
    setLineDash: () => undefined,
    lineWidth: 1,
    strokeStyle: "",
    fillStyle: "",
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const spots: TransformFrameSpots = {
  corners: [
    { x: 10, y: 10 },
    { x: 90, y: 10 },
    { x: 90, y: 60 },
    { x: 10, y: 60 },
  ],
  handles: Array.from({ length: 8 }, (_, index) => ({ x: index * 10, y: 5 })),
  anchor: { x: 50, y: 35 },
  reset: { x: 64, y: 49 },
  dpr: 1,
};

describe("paintTransformFrame (TL-MOVE-01, TL-SHAPE-01)", () => {
  it("draws the dashed outline through the corners by default", () => {
    const { ctx, calls } = recorder();
    paintTransformFrame(ctx, spots);
    expect(calls).toContain("lineTo 90,60");
    expect(calls.filter((call) => call === "strokeRect")).toHaveLength(9);
  });

  it("draws only the handles, the anchor and the reset button without the outline", () => {
    const { ctx, calls } = recorder();
    paintTransformFrame(ctx, { ...spots, outline: false });
    expect(calls).not.toContain("lineTo 90,60");
    expect(calls).not.toContain("moveTo 10,10");
    expect(calls.filter((call) => call === "strokeRect")).toHaveLength(9);
    expect(calls).toContain("arc");
  });
});
