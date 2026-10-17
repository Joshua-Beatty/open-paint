import { applyAffine, IDENTITY_AFFINE } from "@openpaint/document";
import { describe, expect, it } from "vitest";
import {
  CENTER_PIVOT,
  distanceToRings,
  insideRings,
  onShapeBody,
  placeByGesture,
  placementAnchor,
  placementTransform,
  type ShapePlacement,
  snapAngle,
} from "./shape-transform";
import { gestureResult, ROTATION_SNAP } from "./transform-frame";

const BOX = { left: 10, top: 20, right: 50, bottom: 40 };
const FLAT: ShapePlacement = { box: BOX, angle: 0, pivot: CENTER_PIVOT };
const SOURCE = { x: 10, y: 20, width: 40, height: 20 };

function start(placement: ShapePlacement, press: { x: number; y: number }) {
  return { m: placementTransform(placement), anchor: placementAnchor(placement), press };
}

/** The image positions of the placement's corners, clockwise from its own top left. */
function cornersOf(placement: ShapePlacement) {
  const m = placementTransform(placement);
  const { box } = placement;
  return [
    applyAffine(m, box.left, box.top),
    applyAffine(m, box.right, box.top),
    applyAffine(m, box.right, box.bottom),
    applyAffine(m, box.left, box.bottom),
  ];
}

const SQUARE = [
  [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ],
];

describe("shape body hit test (TL-SHAPE-01)", () => {
  it("is inside the enclosed area under the even-odd rule", () => {
    expect(insideRings(SQUARE, { x: 5, y: 5 })).toBe(true);
    expect(insideRings(SQUARE, { x: 15, y: 5 })).toBe(false);
    const hole = [
      ...SQUARE,
      [
        { x: 3, y: 3 },
        { x: 7, y: 3 },
        { x: 7, y: 7 },
        { x: 3, y: 7 },
      ],
    ];
    expect(insideRings(hole, { x: 5, y: 5 })).toBe(false);
    expect(insideRings(hole, { x: 1, y: 5 })).toBe(true);
  });

  it("measures the distance to the nearest edge", () => {
    expect(distanceToRings(SQUARE, { x: 13, y: 5 })).toBeCloseTo(3, 9);
    expect(distanceToRings(SQUARE, { x: 13, y: 14 })).toBeCloseTo(5, 9);
  });

  it("counts the outline's reach as body, and nothing beyond it", () => {
    expect(onShapeBody(SQUARE, { x: 5, y: 5 }, 0)).toBe(true);
    expect(onShapeBody(SQUARE, { x: 14, y: 5 }, 5)).toBe(true);
    expect(onShapeBody(SQUARE, { x: 16, y: 5 }, 5)).toBe(false);
  });
});

describe("placeByGesture (TL-MOVE-01 for shapes)", () => {
  it("moves the box by whole pixels and keeps the angle", () => {
    const gesture = { kind: "move" as const, start: start(FLAT, { x: 20, y: 25 }) };
    const result = gestureResult(
      SOURCE,
      gesture,
      { x: 23.4, y: 22.6 },
      { shift: false, alt: false },
    );
    const placed = placeByGesture(FLAT, "move", result.m, result.anchor, false);
    expect(placed.box).toEqual({ left: 13, top: 18, right: 53, bottom: 38 });
    expect(placed.angle).toBe(0);
  });

  it("turns the shape about its centre without moving the box", () => {
    const gesture = { kind: "rotate" as const, start: start(FLAT, { x: 60, y: 30 }) };
    const result = gestureResult(SOURCE, gesture, { x: 30, y: 60 }, { shift: false, alt: false });
    const placed = placeByGesture(FLAT, "rotate", result.m, result.anchor, false);
    expect(placed.angle).toBeCloseTo(Math.PI / 2, 9);
    expect(placed.box).toEqual(BOX);
    const [topLeft] = cornersOf(placed);
    expect(topLeft?.x).toBeCloseTo(40, 9);
    expect(topLeft?.y).toBeCloseTo(10, 9);
  });

  it("turns the shape about a moved anchor, keeping the anchor where it is", () => {
    const anchored: ShapePlacement = { ...FLAT, pivot: { x: 0, y: 0 } };
    const gesture = { kind: "rotate" as const, start: start(anchored, { x: 60, y: 20 }) };
    const result = gestureResult(SOURCE, gesture, { x: 10, y: 70 }, { shift: false, alt: false });
    const placed = placeByGesture(anchored, "rotate", result.m, result.anchor, false);
    expect(placed.angle).toBeCloseTo(Math.PI / 2, 9);
    const corners = cornersOf(placed);
    // The top-left corner was the anchor, so it stays; the top-right corner swings below it.
    expect(corners[0]?.x).toBeCloseTo(10, 9);
    expect(corners[0]?.y).toBeCloseTo(20, 9);
    expect(corners[1]?.x).toBeCloseTo(10, 9);
    expect(corners[1]?.y).toBeCloseTo(60, 9);
    const anchor = applyAffine(placementTransform(placed), ...xy(placementAnchor(placed)));
    expect(anchor.x).toBeCloseTo(10, 9);
    expect(anchor.y).toBeCloseTo(20, 9);
  });

  it("snaps the shape's own angle to 15 degree steps with Shift", () => {
    const turned: ShapePlacement = { ...FLAT, angle: (7 * Math.PI) / 180 };
    const gesture = { kind: "rotate" as const, start: start(turned, { x: 60, y: 30 }) };
    // A 20 degree turn of the pointer about the centre (30, 30).
    const turn = (20 * Math.PI) / 180;
    const p = { x: 30 + 30 * Math.cos(turn), y: 30 + 30 * Math.sin(turn) };
    const result = gestureResult(SOURCE, gesture, p, { shift: false, alt: false });
    expect(placeByGesture(turned, "rotate", result.m, result.anchor, false).angle).toBeCloseTo(
      (27 * Math.PI) / 180,
      9,
    );
    expect(placeByGesture(turned, "rotate", result.m, result.anchor, true).angle).toBeCloseTo(
      (30 * Math.PI) / 180,
      9,
    );
    expect(snapAngle((-8 * Math.PI) / 180)).toBeCloseTo(-ROTATION_SNAP, 9);
  });

  it("resizes a turned shape along its own axes, keeping the opposite edge in place", () => {
    const turned: ShapePlacement = { ...FLAT, angle: Math.PI / 2 };
    const m = placementTransform(turned);
    // The east handle of the turned box, and 10 px further along its own x axis.
    const east = applyAffine(m, 50, 30);
    const gesture = {
      kind: "scale" as const,
      handle: "e" as const,
      start: start(turned, east),
    };
    const result = gestureResult(
      SOURCE,
      gesture,
      { x: east.x, y: east.y + 10 },
      { shift: false, alt: false },
    );
    const placed = placeByGesture(turned, "scale", result.m, result.anchor, false);
    expect(placed.box.right - placed.box.left).toBe(50);
    expect(placed.box.bottom - placed.box.top).toBe(20);
    expect(placed.angle).toBe(Math.PI / 2);
    const before = cornersOf(turned);
    const after = cornersOf(placed);
    // The west edge (top-left and bottom-left corners) stays put.
    for (const index of [0, 3]) {
      expect(after[index]?.x).toBeCloseTo(before[index]?.x ?? 0, 9);
      expect(after[index]?.y).toBeCloseTo(before[index]?.y ?? 0, 9);
    }
  });

  it("keeps an unturned resize on whole pixels", () => {
    const gesture = {
      kind: "scale" as const,
      handle: "se" as const,
      start: start(FLAT, { x: 50, y: 40 }),
    };
    const result = gestureResult(
      SOURCE,
      gesture,
      { x: 55.4, y: 47.7 },
      { shift: false, alt: false },
    );
    const placed = placeByGesture(FLAT, "scale", result.m, result.anchor, false);
    expect(placed.box).toEqual({ left: 10, top: 20, right: 55, bottom: 48 });
    expect(placementTransform(placed)).toBe(IDENTITY_AFFINE);
  });

  it("moves the anchor as a fraction of the box", () => {
    const gesture = { kind: "anchor" as const, start: start(FLAT, { x: 30, y: 30 }) };
    const result = gestureResult(SOURCE, gesture, { x: 20, y: 25 }, { shift: false, alt: false });
    const placed = placeByGesture(FLAT, "anchor", result.m, result.anchor, false);
    expect(placed.pivot).toEqual({ x: 0.25, y: 0.25 });
    expect(placed.box).toEqual(BOX);
  });
});

function xy(point: { x: number; y: number }): [number, number] {
  return [point.x, point.y];
}
