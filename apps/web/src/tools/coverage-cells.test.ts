// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { rasterizeSelection, rect } from "@openpaint/document";
import { strokeShapes } from "@openpaint/tools";
import { beforeAll, describe, expect, it } from "vitest";
import { COVERAGE_CELL, coverageParts } from "./coverage-cells";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

/** The parts drawn into one coverage over `area`. */
function assemble(parts: ReturnType<typeof coverageParts>, area: ReturnType<typeof rect>) {
  const out = new Uint8Array(area.width * area.height);
  for (const part of parts) {
    for (let y = 0; y < part.area.height; y++) {
      for (let x = 0; x < part.area.width; x++) {
        const at = (part.area.y + y - area.y) * area.width + (part.area.x + x - area.x);
        out[at] = Math.max(out[at] ?? 0, part.coverage[y * part.area.width + x] ?? 0);
      }
    }
  }
  return out;
}

describe("coverageParts (L2)", () => {
  // A 3 px stroke turned 30 degrees, about 600 px long: its box is far larger than itself.
  const angle = Math.PI / 6;
  const from = { x: 13.3, y: 21.7 };
  const to = { x: from.x + 600 * Math.cos(angle), y: from.y + 600 * Math.sin(angle) };
  const [stroke] = strokeShapes([from, to], {
    width: 3,
    dash: "Solid",
    startCap: "Flat",
    endCap: "Flat",
  });
  const area = rect(5, 10, 540, 330);

  for (const mode of ["aliased", "antialiased"] as const) {
    it(`gives the pixels of one rasterization over the whole box, ${mode}`, () => {
      if (stroke === undefined) throw new Error("no stroke");
      const flat = stroke.map((ring) => ring.flatMap((point) => [point.x, point.y]));
      const whole = rasterizeSelection(flat, area, mode);
      const parts = coverageParts(stroke, area, mode);
      expect([...assemble(parts, area)]).toEqual([...whole]);
      const covered = parts.reduce((sum, part) => sum + part.area.width * part.area.height, 0);
      expect(covered).toBeLessThan((area.width * area.height) / 3);
    });
  }

  it("rasterizes a small area in one part", () => {
    const small = rect(0, 0, COVERAGE_CELL, COVERAGE_CELL);
    const square = [
      [
        { x: 2, y: 2 },
        { x: 30, y: 2 },
        { x: 30, y: 30 },
      ],
    ];
    expect(coverageParts(square, small, "aliased")).toHaveLength(1);
  });

  it("keeps the cells inside a wide polygon that no edge crosses", () => {
    const big = [
      [
        { x: 0, y: 0 },
        { x: 400, y: 0 },
        { x: 400, y: 400 },
        { x: 0, y: 400 },
      ],
    ];
    const box = rect(0, 0, 400, 400);
    const parts = coverageParts(big, box, "aliased");
    expect(assemble(parts, box).every((value) => value === 255)).toBe(true);
  });
});
