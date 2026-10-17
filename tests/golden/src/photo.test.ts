import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { RgbaImage } from "@openpaint/codecs";
import { Surface } from "@openpaint/document";
import {
  glowCpu,
  redEyeCpu,
  rotateZoomCpu,
  sharpenCpu,
  softenPortraitCpu,
  straightenCpu,
  vignetteCpu,
} from "@openpaint/effects";
import { initCpu } from "@openpaint/engine";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BLUR_INPUT,
  GLOW_CASES,
  RED_EYE_CASES,
  ROTATE_ZOOM_CASES,
  redEyeCoverage,
  redEyeInput,
  SHARPEN_CASES,
  SOFTEN_CASES,
  STRAIGHTEN_CASES,
  VIGNETTE_CASES,
} from "./cases";
import { CPU_TOLERANCE, diffImages } from "./compare";
import { readReference, writeActual } from "./node-io";

describe("Photo effects: Rust/WASM against the stored references", () => {
  let input: Surface;

  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
    const image: RgbaImage = await readReference(BLUR_INPUT);
    input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  });

  const check = async (id: string, expectedPath: string, out: Surface) => {
    const expected = await readReference(expectedPath);
    const actual: RgbaImage = {
      width: out.width,
      height: out.height,
      data: new Uint8Array(out.data),
    };
    const diff = diffImages(actual, expected);
    if (diff.maxDifference > CPU_TOLERANCE) {
      const saved = await writeActual(id, actual);
      expect.fail(`${id}: max difference ${diff.maxDifference}; actual saved to ${saved}`);
    }
    expect(diff.maxDifference).toBe(CPU_TOLERANCE);
  };

  it.each(GLOW_CASES)("$id matches its reference exactly", async (kase) => {
    await check(kase.id, kase.expected, glowCpu(input, kase.params));
  });

  it.each(SOFTEN_CASES)("$id matches its reference exactly", async (kase) => {
    await check(kase.id, kase.expected, softenPortraitCpu(input, kase.params));
  });

  it.each(SHARPEN_CASES)("$id matches its reference exactly", async (kase) => {
    await check(kase.id, kase.expected, sharpenCpu(input, kase.params));
  });

  it.each(STRAIGHTEN_CASES)("$id matches its reference exactly", async (kase) => {
    await check(kase.id, kase.expected, straightenCpu(input, kase.params));
  });

  it.each(VIGNETTE_CASES)("$id matches its reference exactly", async (kase) => {
    await check(kase.id, kase.expected, vignetteCpu(input, kase.params));
  });

  it.each(ROTATE_ZOOM_CASES)("$id matches its reference exactly", async (kase) => {
    await check(kase.id, kase.expected, rotateZoomCpu(input, kase.params));
  });

  it.each(RED_EYE_CASES)("$id matches its reference exactly", async (kase) => {
    const eyes = redEyeInput();
    const eyesSurface = new Surface(eyes.width, eyes.height, new Uint8ClampedArray(eyes.data));
    const coverage = redEyeCoverage(kase, eyes.width, eyes.height);
    await check(kase.id, kase.expected, redEyeCpu(eyesSurface, kase.params, coverage));
  });
});
