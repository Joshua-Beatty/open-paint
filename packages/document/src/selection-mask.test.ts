/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it } from "vitest";
import { rect } from "./geometry";
import { maskRunPolygons, rasterizeSelection } from "./selection-mask";
import { rectPolygon } from "./selection-polygons";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

describe("rasterizeSelection", () => {
  it("rasterizes only the requested area, offset from the polygon origin", () => {
    const mask = rasterizeSelection([rectPolygon(rect(2, 2, 2, 2))], rect(1, 1, 4, 4), "aliased");
    expect(Array.from(mask)).toEqual([
      0,
      0,
      0,
      0, //
      0,
      255,
      255,
      0, //
      0,
      255,
      255,
      0, //
      0,
      0,
      0,
      0,
    ]);
  });

  it("returns an all-zero mask when no polygon is given", () => {
    expect(rasterizeSelection([], rect(0, 0, 2, 1), "antialiased")).toEqual(new Uint8Array(2));
  });
});

describe("maskRunPolygons", () => {
  it("turns each horizontal run of set pixels into one pixel-aligned rectangle", () => {
    const mask = new Uint8Array([255, 255, 0, 0, 255, 255]);
    expect(maskRunPolygons(mask, 3, 2)).toEqual([
      [0, 0, 2, 0, 2, 1, 0, 1],
      [1, 1, 3, 1, 3, 2, 1, 2],
    ]);
  });

  it("returns no polygons for an empty mask", () => {
    expect(maskRunPolygons(new Uint8Array(4), 2, 2)).toEqual([]);
  });
});
