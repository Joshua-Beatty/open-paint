/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { compositeRgba8, initCpu, premultiplyRgba8, resampleLanczos3Rgba8 } from "./cpu";

describe("Rust/WASM CPU kernels", () => {
  let threads = 0;

  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    ({ threads } = await initCpu(await readFile(wasmPath)));
  });

  it("stays single-threaded outside a cross-origin isolated page", () => {
    expect(threads).toBe(1);
  });

  it("premultiplies straight-alpha RGBA8 in place", () => {
    const px = new Uint8Array([255, 128, 0, 255, 255, 128, 1, 128, 200, 100, 50, 0]);
    premultiplyRgba8(px);
    expect([...px]).toEqual([255, 128, 0, 255, 128, 64, 1, 128, 0, 0, 0, 0]);
  });

  it("composites an RGBA8 tile over another in place", () => {
    const dst = new Uint8Array([200, 100, 50, 255, 200, 100, 50, 128]);
    const src = new Uint8Array([0, 100, 200, 128, 100, 200, 0, 200]);
    compositeRgba8(dst, src, 1, 255);
    // Multiply (DOC-BLD-02). Pixel 1: Y = 127, J = 128, K = 0, B = (0, 39, 39), Ra = 255.
    // Pixel 2: Y = 28, J = 100, K = 100, B = (78, 78, 0), Ra = 228.
    expect([...dst]).toEqual([100, 69, 44, 255, 103, 134, 6, 228]);
  });

  it("downsamples premultiplied RGBA8 with Lanczos-3", () => {
    const solid = new Uint8Array(4 * 4 * 4).fill(0);
    for (let i = 0; i < solid.length; i += 4) solid.set([64, 0, 0, 128], i);
    const out = resampleLanczos3Rgba8(solid, 4, 4, 2, 2);
    expect([...out.subarray(0, 4)]).toEqual([64, 0, 0, 128]);
    expect(out.length).toBe(2 * 2 * 4);
    expect(() => resampleLanczos3Rgba8(new Uint8Array(4), 2, 2, 1, 1)).toThrow();
  });

  it("rejects unknown blend modes and mismatched tiles", () => {
    expect(() => compositeRgba8(new Uint8Array(4), new Uint8Array(4), 14, 255)).toThrow(
      "unknown blend mode 14",
    );
    expect(() => compositeRgba8(new Uint8Array(8), new Uint8Array(4), 0, 255)).toThrow(
      "equal-sized RGBA8",
    );
  });
});
