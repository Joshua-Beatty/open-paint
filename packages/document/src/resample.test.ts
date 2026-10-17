/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm, { resample_rgba8 } from "@openpaint/cpu";
import { beforeAll, describe, expect, it } from "vitest";
import { RESAMPLE_FILTERS, resampleSurface } from "./resample";
import { Surface } from "./surface";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

function surface(width: number, height: number, pixels: readonly number[]): Surface {
  return new Surface(width, height, new Uint8ClampedArray(pixels));
}

describe("resampleSurface", () => {
  it("lists the nine DOC-IMG-02 choices with ids the kernel accepts", () => {
    expect(RESAMPLE_FILTERS).toHaveLength(9);
    const src = new Uint8Array([0, 0, 0, 255]);
    for (let id = 0; id < RESAMPLE_FILTERS.length; id++) {
      expect(() => resample_rgba8(src, 1, 1, 1, 1, id, true)).not.toThrow();
    }
    expect(() => resample_rgba8(src, 1, 1, 1, 1, RESAMPLE_FILTERS.length, true)).toThrow(
      /unknown resampling filter/,
    );
  });

  it("returns a new surface of the requested size and leaves the source alone", () => {
    const src = surface(2, 2, [10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 1, 2, 3, 0]);
    const before = src.data.slice();
    const out = resampleSurface(src, 4, 3, { filter: "bicubic", linearLight: false });
    expect(out).not.toBe(src);
    expect([out.width, out.height, out.data.length]).toEqual([4, 3, 4 * 3 * 4]);
    expect(src.data).toEqual(before);
  });

  it("keeps a pixel's color when nearest-neighbor doubles the image", () => {
    const src = surface(1, 1, [12, 34, 56, 78]);
    const out = resampleSurface(src, 2, 2, { filter: "nearest", linearLight: true });
    expect(Array.from(out.data)).toEqual([
      12, 34, 56, 78, 12, 34, 56, 78, 12, 34, 56, 78, 12, 34, 56, 78,
    ]);
  });

  it("averages black and white in linear light when gamma correction is on", () => {
    const src = surface(2, 1, [0, 0, 0, 255, 255, 255, 255, 255]);
    const linear = resampleSurface(src, 1, 1, { filter: "fant", linearLight: true });
    const gamma = resampleSurface(src, 1, 1, { filter: "fant", linearLight: false });
    expect(Array.from(linear.data)).toEqual([188, 188, 188, 255]);
    expect(Array.from(gamma.data)).toEqual([128, 128, 128, 255]);
  });

  it("rejects sizes that are not positive integers", () => {
    const src = surface(1, 1, [0, 0, 0, 255]);
    const options = { filter: "lanczos3", linearLight: true } as const;
    expect(() => resampleSurface(src, 0, 1, options)).toThrow(RangeError);
    expect(() => resampleSurface(src, 1, 2.5, options)).toThrow(RangeError);
    expect(() => resampleSurface(src, Number.NaN, 1, options)).toThrow(RangeError);
  });
});
