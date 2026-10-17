import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { RgbaImage } from "@openpaint/codecs";
import { Surface } from "@openpaint/document";
import {
  addNoiseCpu,
  distortAffineCpu,
  fragmentBlurCpu,
  frostedGlassCpu,
  medianBlurCpu,
  morphologyCpu,
  motionBlurCpu,
  noiseCpu,
  pixelateCpu,
  radialBlurCpu,
  reduceNoiseCpu,
  surfaceBlurCpu,
  zoomBlurCpu,
} from "@openpaint/effects";
import { initCpu } from "@openpaint/engine";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ADD_NOISE_CASES,
  BLUR_INPUT,
  DISTORT_CASES,
  FRAGMENT_CASES,
  FROST_CASES,
  MEDIAN_CASES,
  MORPHOLOGY_CASES,
  MOTION_CASES,
  NOISE_CASES,
  PIXELATE_CASES,
  RADIAL_CASES,
  REDUCE_NOISE_CASES,
  SURFACE_CASES,
  WARP_CASES,
  ZOOM_CASES,
} from "./cases";
import { CPU_TOLERANCE, diffImages } from "./compare";
import { readReference, writeActual } from "./node-io";
import { warpReference } from "./warp-reference";

describe("Distortion engine and pixel noise: Rust/WASM against the stored references", () => {
  let input: Surface;

  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
    const image: RgbaImage = await readReference(BLUR_INPUT);
    input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  });

  it.each(DISTORT_CASES)("$id matches its reference exactly", async (kase) => {
    const expected = await readReference(kase.expected);
    const out = distortAffineCpu(input, kase.matrix, kase.quality, kase.edge);
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

  it.each(WARP_CASES)("$id matches its reference exactly", async (kase) => {
    const expected = await readReference(kase.expected);
    const out = warpReference(kase, input);
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

  it.each(FROST_CASES)("$id matches its reference exactly", async (kase) => {
    const expected = await readReference(kase.expected);
    const out = frostedGlassCpu(input, kase.params);
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

  it.each(PIXELATE_CASES)("$id matches its reference exactly", async (kase) => {
    const expected = await readReference(kase.expected);
    const out = pixelateCpu(input, kase.params);
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

  it.each(MORPHOLOGY_CASES)("$id matches its reference exactly", async (kase) => {
    const expected = await readReference(kase.expected);
    const out = morphologyCpu(input, kase.params);
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

  it.each(FRAGMENT_CASES)("$id matches its reference exactly", async (kase) => {
    const expected = await readReference(kase.expected);
    const out = fragmentBlurCpu(input, kase.params);
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

  it.each(RADIAL_CASES)("$id matches its reference exactly", async (kase) => {
    const expected = await readReference(kase.expected);
    const out = radialBlurCpu(input, kase.params);
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

  it.each(ZOOM_CASES)("$id matches its reference exactly", async (kase) => {
    const expected = await readReference(kase.expected);
    const out = zoomBlurCpu(input, kase.params);
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

  it.each(MEDIAN_CASES)("$id matches its reference exactly", async (kase) => {
    const expected = await readReference(kase.expected);
    const out = medianBlurCpu(input, kase.params);
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

  it.each(SURFACE_CASES)("$id matches its reference exactly", async (kase) => {
    const expected = await readReference(kase.expected);
    const out = surfaceBlurCpu(input, kase.params);
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

  it.each(MOTION_CASES)("$id matches its reference exactly", async (kase) => {
    const expected = await readReference(kase.expected);
    const out = motionBlurCpu(input, kase.params);
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

  it.each(ADD_NOISE_CASES)("$id matches its reference exactly", async (kase) => {
    const expected = await readReference(kase.expected);
    const out = addNoiseCpu(input, kase.params);
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

  it.each(REDUCE_NOISE_CASES)("$id matches its reference exactly", async (kase) => {
    const expected = await readReference(kase.expected);
    const out = reduceNoiseCpu(input, kase.params);
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

  it.each(NOISE_CASES)("$id matches its reference exactly", async (kase) => {
    const expected = await readReference(kase.expected);
    const out = noiseCpu(input.width, input.height, kase.seed);
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
