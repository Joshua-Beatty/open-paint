/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  ellipsePolygon,
  rect,
  rotationAboutAffine,
  Selection,
  type SelectionPolygon,
} from "@openpaint/document";
import { beforeAll, describe, expect, it } from "vitest";
import { initCpu } from "./cpu";
import { runsToMask, shapeRuns } from "./shape-runs";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initCpu(await readFile(wasmPath));
});

function flat(polygons: readonly SelectionPolygon[]) {
  const coords = new Float64Array(polygons.flatMap((ring) => [...ring]));
  const counts = new Uint32Array(polygons.map((ring) => ring.length / 2));
  return { coords, counts };
}

describe("shape runs (the selection mask as runs)", () => {
  const shapes: Record<string, SelectionPolygon[]> = {
    rect: [[10.5, 7.25, 90.75, 7.25, 90.75, 60.5, 10.5, 60.5]],
    ellipse: [ellipsePolygon(rect(12.3, 4.7, 80.1, 55.9))],
    concave: [[5, 5, 95, 12.5, 50, 35, 92, 66, 8.25, 60, 40, 33]],
    holes: [
      [0, 0, 100, 0, 100, 70, 0, 70],
      [20, 20, 60, 25, 40, 50],
    ],
  };
  const areas = [rect(0, 0, 100, 70), rect(-7, 3, 120, 61), rect(30, 20, 41, 33)];
  for (const [name, rings] of Object.entries(shapes)) {
    for (const quality of ["antialiased", "aliased"] as const) {
      it(`matches rasterize_polygons byte for byte: ${name}, ${quality}, rotated`, () => {
        const turned = new Selection(rings, quality)
          .transform(rotationAboutAffine(50, 35, 0.37))
          .commit();
        const polygons = turned.effectivePolygons();
        const { coords, counts } = flat(polygons);
        for (const area of areas) {
          const runs = shapeRuns(coords, counts, area, quality === "antialiased");
          expect(runsToMask(runs, area.width, area.height)).toEqual(turned.mask(area));
        }
      });
    }
  }

  it("has no runs for an empty shape", () => {
    const runs = shapeRuns(new Float64Array(0), new Uint32Array(0), rect(0, 0, 4, 4), true);
    expect(runs.breaks.length).toBe(0);
    expect(runsToMask(runs, 4, 4)).toEqual(new Uint8Array(16));
  });
});
