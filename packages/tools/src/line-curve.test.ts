import { describe, expect, it } from "vitest";
import {
  ARROWHEAD_SCALE,
  CURVE_TOLERANCE,
  type CurveKind,
  constrainAngle,
  controlPoints,
  controlPosition,
  createLine,
  curveSamples,
  distanceToPolyline,
  type LinePoint,
  lineMeasure,
  moveControl,
  type StrokeShape,
  type StrokeStyle,
  snapToPixelCenter,
  strokeShapes,
  translateLine,
} from "./line-curve";

const plain: StrokeStyle = { width: 1, dash: "Solid", startCap: "Flat", endCap: "Flat" };

function style(overrides: Partial<StrokeStyle>): StrokeStyle {
  return { ...plain, ...overrides };
}

/** The bounding box of one ring, from its vertices. */
function boxOf(ring: readonly LinePoint[]) {
  const xs = ring.map((p) => p.x);
  const ys = ring.map((p) => p.y);
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}

function cubicAt(points: readonly LinePoint[], t: number): LinePoint {
  const [p0, p1, p2, p3] = points as [LinePoint, LinePoint, LinePoint, LinePoint];
  const u = 1 - t;
  return {
    x: u ** 3 * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t ** 3 * p3.x,
    y: u ** 3 * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t ** 3 * p3.y,
  };
}

describe("translateLine", () => {
  it("moves the endpoints and the dragged controls, and leaves the others on the line", () => {
    const line = moveControl(createLine({ x: 0.5, y: 0.5 }, { x: 30.5, y: 0.5 }), 1, {
      x: 20,
      y: 9,
    });
    const moved = translateLine(line, 3, -2);
    expect(moved.start).toEqual({ x: 3.5, y: -1.5 });
    expect(moved.end).toEqual({ x: 33.5, y: -1.5 });
    expect(moved.controls[0]).toEqual({ t: 1 / 3 });
    expect(moved.controls[1]).toEqual({ t: 2 / 3, at: { x: 23, y: 7 } });
    expect(controlPosition(moved, 0).x).toBeCloseTo(13.5, 9);
  });
});

describe("distanceToPolyline", () => {
  const path = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ];

  it("measures to the nearest segment, and past the ends to the end points", () => {
    expect(distanceToPolyline(path, { x: 5, y: 2 })).toBeCloseTo(2, 9);
    expect(distanceToPolyline(path, { x: 12, y: 5 })).toBeCloseTo(2, 9);
    expect(distanceToPolyline(path, { x: -3, y: -4 })).toBeCloseTo(5, 9);
    // The path is open: the gap from the last point back to the first does not count.
    expect(distanceToPolyline(path, { x: 5, y: 5 })).toBeCloseTo(5, 9);
  });

  it("measures to a single point", () => {
    expect(distanceToPolyline([{ x: 1, y: 1 }], { x: 4, y: 5 })).toBeCloseTo(5, 9);
  });
});

describe("snapToPixelCenter", () => {
  it("moves a point to the center of its pixel", () => {
    expect(snapToPixelCenter({ x: 10.2, y: 3.9 })).toEqual({ x: 10.5, y: 3.5 });
    expect(snapToPixelCenter({ x: 0, y: 0 })).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe("constrainAngle (TL-LINE-01 Shift)", () => {
  it("snaps the angle to 15 degree steps and keeps the length", () => {
    const anchor = { x: 0, y: 0 };
    const point = { x: 10, y: 3 };
    const result = constrainAngle(anchor, point);
    const angle = (Math.atan2(result.y, result.x) * 180) / Math.PI;
    expect(angle).toBeCloseTo(15, 9);
    expect(Math.hypot(result.x, result.y)).toBeCloseTo(Math.hypot(10, 3), 9);
  });

  it("leaves a point already on a 15 degree step at its angle", () => {
    const result = constrainAngle({ x: 5, y: 5 }, { x: 5, y: 15 });
    expect(result.x).toBeCloseTo(5, 9);
    expect(result.y).toBeCloseTo(15, 9);
  });

  it("returns the point itself when it is the anchor", () => {
    expect(constrainAngle({ x: 2, y: 2 }, { x: 2, y: 2 })).toEqual({ x: 2, y: 2 });
  });
});

describe("lineMeasure (TL-LINE-01 status)", () => {
  it("gives the offset, the length and the clockwise angle", () => {
    expect(lineMeasure({ x: 0, y: 0 }, { x: 3, y: 4 })).toEqual({
      dx: 3,
      dy: 4,
      length: 5,
      angle: 53,
    });
    expect(lineMeasure({ x: 0, y: 0 }, { x: 0, y: -10 })).toEqual({
      dx: 0,
      dy: -10,
      length: 10,
      angle: 270,
    });
  });

  it("returns no negative zero for a level line", () => {
    expect(Object.is(lineMeasure({ x: 1, y: 1 }, { x: 0, y: 1 }).dy, 0)).toBe(true);
  });
});

describe("control points", () => {
  it("places untouched controls a third and two thirds along the line", () => {
    const line = createLine({ x: 0, y: 0 }, { x: 30, y: 0 });
    expect(controlPosition(line, 0)).toEqual({ x: 10, y: 0 });
    expect(controlPosition(line, 1)).toEqual({ x: 20, y: 0 });
  });

  it("keeps an untouched control on the line when an endpoint moves", () => {
    const moved = { ...createLine({ x: 0, y: 0 }, { x: 30, y: 0 }), end: { x: 30, y: 30 } };
    expect(controlPosition(moved, 0)).toEqual({ x: 10, y: 10 });
  });

  it("keeps a dragged control where it was put", () => {
    const line = moveControl(createLine({ x: 0, y: 0 }, { x: 30, y: 0 }), 1, { x: 22, y: 9 });
    expect(controlPoints(line)).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 22, y: 9 },
      { x: 30, y: 0 },
    ]);
  });
});

describe("curveSamples (TL-LINE-01 curve types)", () => {
  const corners = [
    { x: 0, y: 0 },
    { x: 0, y: 100 },
    { x: 100, y: 100 },
    { x: 100, y: 0 },
  ] as const;

  it("joins the endpoints for a straight line and ignores the controls", () => {
    expect(curveSamples(corners, "Straight")).toEqual([corners[0], corners[3]]);
  });

  it("runs a spline through all four points", () => {
    const samples = curveSamples(corners, "Spline");
    for (const control of [corners[1], corners[2]]) {
      expect(
        Math.min(...samples.map((p) => Math.hypot(p.x - control.x, p.y - control.y))),
      ).toBeLessThan(1e-9);
    }
    expect(samples[0]).toEqual(corners[0]);
    expect(samples[samples.length - 1]).toEqual(corners[3]);
  });

  it("keeps a spline on its line when the controls sit on the line", () => {
    const line = createLine({ x: 0, y: 0 }, { x: 30, y: 0 });
    for (const kind of ["Spline", "Bezier"] as const satisfies readonly CurveKind[]) {
      for (const point of curveSamples(controlPoints(line), kind)) {
        expect(Math.abs(point.y)).toBeLessThan(1e-9);
      }
    }
  });

  it("flattens a cubic Bezier to within the 0.1 px tolerance", () => {
    const poly = curveSamples(corners, "Bezier");
    for (let i = 0; i <= 2000; i++) {
      const point = cubicAt(corners, i / 2000);
      expect(distanceToPolyline(poly, point)).toBeLessThanOrEqual(CURVE_TOLERANCE * 1.05);
    }
  });

  it("gives finite points when controls coincide with the endpoints", () => {
    const degenerate = [
      { x: 4, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 4 },
      { x: 9, y: 4 },
    ] as const;
    for (const kind of ["Spline", "Bezier"] as const satisfies readonly CurveKind[]) {
      for (const point of curveSamples(degenerate, kind)) {
        expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
      }
    }
  });
});

describe("strokeShapes (TL-OPT-PEN)", () => {
  const start = { x: 0, y: 0 };
  const end = { x: 20, y: 0 };

  it("draws one quad for a solid flat line", () => {
    const shapes = strokeShapes([start, end], style({ width: 4 }));
    expect(shapes).toHaveLength(1);
    const ring = shapes[0]?.[0] ?? [];
    expect(boxOf(ring)).toEqual({ left: 0, right: 20, top: -2, bottom: 2 });
  });

  it("gives nothing for a line with no length", () => {
    expect(strokeShapes([start, start], plain)).toEqual([]);
    expect(strokeShapes([start], plain)).toEqual([]);
  });

  it("splits a line into dashes with the pattern of its style", () => {
    const shapes = strokeShapes([start, end], style({ dash: "Dashes" }));
    const spans = shapes.map((shape) => {
      const box = boxOf(shape[0] ?? []);
      return [box.left, box.right];
    });
    expect(spans).toEqual([
      [0, 4],
      [6, 10],
      [12, 16],
      [18, 20],
    ]);
  });

  it("scales the dash pattern by the pen width", () => {
    const shapes = strokeShapes(
      [
        { x: 0, y: 0 },
        { x: 12, y: 0 },
      ],
      style({ width: 2, dash: "Dotted" }),
    );
    expect(shapes.map((shape) => boxOf(shape[0] ?? []).left)).toEqual([0, 6]);
  });

  it("shortens the body and draws a filled arrowhead five pen widths long and wide", () => {
    const shapes = strokeShapes(
      [start, { x: 50, y: 0 }],
      style({ width: 2, endCap: "ArrowFilled" }),
    );
    const body = boxOf(shapes[0]?.[0] ?? []);
    expect(body.right).toBe(50 - 2 * ARROWHEAD_SCALE);
    const head = shapes.find((shape) => shape[0]?.some((p) => p.x === 50 && p.y === 0));
    expect(head).toBeDefined();
    const ring = head?.[0] ?? [];
    expect(ring).toHaveLength(3);
    expect(ring).toEqual(
      expect.arrayContaining([
        { x: 50, y: 0 },
        { x: 40, y: 5 },
        { x: 40, y: -5 },
      ]),
    );
  });

  it("draws an outline arrowhead as a triangle with a hole", () => {
    const shapes = strokeShapes([start, { x: 50, y: 0 }], style({ width: 2, endCap: "Arrow" }));
    const head = shapes.find((shape) => shape.length === 2);
    expect(head).toBeDefined();
    const [outer = [], inner = []] = head ?? [];
    expect(outer).toHaveLength(3);
    expect(inner).toHaveLength(3);
    for (const vertex of inner) {
      expect(vertex.x).toBeGreaterThan(40);
      expect(vertex.x).toBeLessThan(50);
    }
  });

  it("draws a round cap as a disc with the radius of half the width", () => {
    const shapes = strokeShapes([start, end], style({ width: 4, startCap: "Rounded" }));
    const disc = shapes.find((shape) => shape[0]?.some((p) => p.x < 0));
    const ring = disc?.[0] ?? [];
    expect(ring.length).toBeGreaterThanOrEqual(12);
    for (const point of ring) {
      expect(Math.hypot(point.x, point.y)).toBeCloseTo(2, 9);
    }
  });

  it("joins the flattened pieces of a curve without a seam", () => {
    const poly = curveSamples(
      [
        { x: 0, y: 0 },
        { x: 0, y: 60 },
        { x: 60, y: 60 },
        { x: 60, y: 0 },
      ],
      "Bezier",
    );
    const shapes = strokeShapes(poly, style({ width: 6 }));
    expect(shapes.length).toBeGreaterThan(poly.length);
    for (const shape of shapes) {
      for (const ring of shape) {
        for (const point of ring) {
          expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
        }
      }
    }
  });

  it("uses the arrowhead's full size on a short line by sharing the length", () => {
    const shapes: StrokeShape[] = strokeShapes(
      [start, { x: 4, y: 0 }],
      style({ endCap: "ArrowFilled" }),
    );
    expect(shapes.length).toBeGreaterThan(0);
  });
});
