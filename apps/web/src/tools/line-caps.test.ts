// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { rasterizeSelection, rect } from "@openpaint/document";
import {
  type CapStyle,
  type CurveKind,
  curveSamples,
  type LinePoint,
  strokeShapes,
} from "@openpaint/tools";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const SIZE = 240;
const WIDTH = 40;
const AREA = rect(0, 0, SIZE, SIZE);

/** The coverage of a pen stroke through the curve, the pieces combined by maximum. */
function rasterize(poly: readonly LinePoint[], cap: CapStyle): Uint8Array {
  const out = new Uint8Array(SIZE * SIZE);
  const shapes = strokeShapes(poly, { width: WIDTH, dash: "Solid", startCap: cap, endCap: cap });
  for (const shape of shapes) {
    const coverage = rasterizeSelection(
      shape.map((ring) => ring.flatMap((p) => [p.x, p.y])),
      AREA,
      "antialiased",
    );
    for (let i = 0; i < out.length; i++) out[i] = Math.max(out[i] ?? 0, coverage[i] ?? 0);
  }
  return out;
}

/** A line or an S-curve of length 100 through the image center at `degrees`. */
function path(degrees: number, kind: CurveKind): LinePoint[] {
  const angle = (degrees * Math.PI) / 180;
  const d = { x: Math.cos(angle), y: Math.sin(angle) };
  const n = { x: -d.y, y: d.x };
  const c = SIZE / 2;
  const start = { x: c - d.x * 50, y: c - d.y * 50 };
  const end = { x: c + d.x * 50, y: c + d.y * 50 };
  const bend = kind === "Straight" ? 0 : 30;
  const at = (t: number, k: number) => ({
    x: start.x + (end.x - start.x) * t + n.x * k,
    y: start.y + (end.y - start.y) * t + n.y * k,
  });
  return curveSamples([start, at(1 / 3, bend), at(2 / 3, -bend), end], kind);
}

/**
 * How far the covered pixels reach past the plane through `tip` perpendicular to `outward`: the
 * largest distance, beyond it, of the nearest corner of any pixel with coverage.
 */
function reachPast(coverage: Uint8Array, tip: LinePoint, outward: LinePoint): number {
  let reach = Number.NEGATIVE_INFINITY;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if ((coverage[y * SIZE + x] ?? 0) === 0) continue;
      let nearest = Number.POSITIVE_INFINITY;
      for (const [cx, cy] of [
        [x, y],
        [x + 1, y],
        [x, y + 1],
        [x + 1, y + 1],
      ] as const) {
        nearest = Math.min(nearest, (cx - tip.x) * outward.x + (cy - tip.y) * outward.y);
      }
      reach = Math.max(reach, nearest);
    }
  }
  return reach;
}

function direction(from: LinePoint, to: LinePoint): LinePoint {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  return { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
}

/** The ends of a polyline with their outward directions. */
function ends(poly: readonly LinePoint[]) {
  const [a, b] = poly;
  const y = poly.at(-2);
  const z = poly.at(-1);
  if (!a || !b || !y || !z) throw new Error("short path");
  return [
    { tip: a, outward: direction(b, a) },
    { tip: z, outward: direction(y, z) },
  ];
}

describe("thick pen caps (TL-OPT-PEN)", () => {
  const angles = [0, 17, 45, 90, 133, 200, 315];

  for (const kind of ["Straight", "Spline", "Bezier"] as const) {
    it.each(angles)(`flat caps of a ${kind} line end on the endpoint plane at %i°`, (degrees) => {
      const poly = path(degrees, kind);
      const coverage = rasterize(poly, "Flat");
      for (const { tip, outward } of ends(poly)) {
        // No pixel is covered wholly past the plane through the endpoint.
        expect(reachPast(coverage, tip, outward)).toBeLessThanOrEqual(1e-6);
        // The pixel just inside the end is covered: the cap is not cut short.
        const inside = { x: tip.x - outward.x * 3, y: tip.y - outward.y * 3 };
        expect(coverage[Math.floor(inside.y) * SIZE + Math.floor(inside.x)]).toBe(255);
      }
    });
  }

  it.each(angles)("round caps reach half the width past the endpoints at %i°", (degrees) => {
    const poly = path(degrees, "Bezier");
    const coverage = rasterize(poly, "Rounded");
    for (const { tip, outward } of ends(poly)) {
      const reach = reachPast(coverage, tip, outward);
      expect(reach).toBeGreaterThan(WIDTH / 2 - 2);
      expect(reach).toBeLessThanOrEqual(WIDTH / 2);
    }
  });
});
