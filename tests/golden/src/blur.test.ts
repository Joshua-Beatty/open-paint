import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { RgbaImage } from "@openpaint/codecs";
import { Surface } from "@openpaint/document";
import { bokehBlurCpu, gaussianBlurCpu, sketchBlurCpu, squareBlurCpu } from "@openpaint/effects";
import { initCpu } from "@openpaint/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { BLUR_CASES, BLUR_INPUT, BOKEH_CASES, SKETCH_CASES, SQUARE_CASES } from "./cases";
import { CPU_TOLERANCE, diffImages } from "./compare";
import { readReference, writeActual } from "./node-io";

describe("Square and Sketch Blur: Rust/WASM kernels against the stored references", () => {
  let input: Surface;

  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
    const image: RgbaImage = await readReference(BLUR_INPUT);
    input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  });

  it.each(SQUARE_CASES)("$id matches its reference exactly", async (kase) => {
    const expected = await readReference(kase.expected);
    const out = squareBlurCpu(input, kase.params);
    const actual: RgbaImage = {
      width: out.width,
      height: out.height,
      data: new Uint8Array(out.data),
    };

    const diff = diffImages(actual, expected);
    if (diff.maxDifference > CPU_TOLERANCE) {
      const saved = await writeActual(kase.id, actual);
      expect.fail(`${kase.id}: max difference ${diff.maxDifference}; actual saved to ${saved}`);
    }
    expect(diff.maxDifference).toBe(CPU_TOLERANCE);
  });

  it.each(SKETCH_CASES)("$id matches its reference exactly", async (kase) => {
    const expected = await readReference(kase.expected);
    const out = sketchBlurCpu(input, kase.params);
    const actual: RgbaImage = {
      width: out.width,
      height: out.height,
      data: new Uint8Array(out.data),
    };

    const diff = diffImages(actual, expected);
    if (diff.maxDifference > CPU_TOLERANCE) {
      const saved = await writeActual(kase.id, actual);
      expect.fail(`${kase.id}: max difference ${diff.maxDifference}; actual saved to ${saved}`);
    }
    expect(diff.maxDifference).toBe(CPU_TOLERANCE);
  });
});

describe("Bokeh Blur: Rust/WASM kernel against the stored references", () => {
  let input: Surface;

  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
    const image: RgbaImage = await readReference(BLUR_INPUT);
    input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  });

  it.each(BOKEH_CASES)("$id matches its reference exactly", async (kase) => {
    const expected = await readReference(kase.expected);
    const out = bokehBlurCpu(input, kase.params);
    const actual: RgbaImage = {
      width: out.width,
      height: out.height,
      data: new Uint8Array(out.data),
    };

    const diff = diffImages(actual, expected);
    if (diff.maxDifference > CPU_TOLERANCE) {
      const saved = await writeActual(kase.id, actual);
      expect.fail(`${kase.id}: max difference ${diff.maxDifference}; actual saved to ${saved}`);
    }
    expect(diff.maxDifference).toBe(CPU_TOLERANCE);
  });
});

describe("Gaussian Blur: Rust/WASM kernel against the stored references", () => {
  let input: Surface;

  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
    const image: RgbaImage = await readReference(BLUR_INPUT);
    input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  });

  it.each(BLUR_CASES)("$id matches its reference exactly", async (kase) => {
    const expected = await readReference(kase.expected);
    const out = gaussianBlurCpu(input, {
      radius: kase.radius,
      gammaBoost: kase.gammaBoost,
      quality: kase.quality,
    });
    const actual: RgbaImage = {
      width: out.width,
      height: out.height,
      data: new Uint8Array(out.data),
    };

    const diff = diffImages(actual, expected);
    if (diff.maxDifference > CPU_TOLERANCE) {
      const saved = await writeActual(kase.id, actual);
      expect.fail(`${kase.id}: max difference ${diff.maxDifference}; actual saved to ${saved}`);
    }
    expect(diff.maxDifference).toBe(CPU_TOLERANCE);
  });
});
