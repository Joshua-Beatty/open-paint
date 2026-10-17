/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Surface } from "@openpaint/document";
import {
  type GlowParams,
  glowCpu,
  type SharpenParams,
  type SoftenPortraitParams,
  type StraightenParams,
  sharpenCpu,
  softenPortraitCpu,
  straightenCpu,
  type VignetteParams,
  vignetteCpu,
} from "@openpaint/effects";
import { beforeAll, describe, expect, it } from "vitest";
import { initCpu } from "./cpu";
import { GpuGlow, GpuSharpen, GpuSoftenPortrait, GpuStraighten, GpuVignette } from "./gpu-photo";

/** Skips every test in this file when the runtime has no WebGPU adapter (e.g. plain Node). */
async function requestTestDevice(): Promise<GPUDevice | undefined> {
  const gpu = globalThis.navigator?.gpu;
  if (!gpu) return undefined;
  try {
    const adapter = await gpu.requestAdapter();
    return await adapter?.requestDevice();
  } catch {
    return undefined;
  }
}

const device = await requestTestDevice();
const WIDTH = 40;
const HEIGHT = 24;

/** A deterministic image with varied color, brightness and alpha. */
function sample(seed: number): Surface {
  let state = seed >>> 0;
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let i = 0; i < data.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    data[i] = state >>> 24;
  }
  return new Surface(WIDTH, HEIGHT, data);
}

function maxDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return max;
}

const GLOW_PARAMETERS: readonly GlowParams[] = [
  { radius: 6, brightness: 10, contrast: 10 },
  { radius: 2.5, brightness: -40, contrast: 80 },
];

const SOFTEN_PARAMETERS: readonly SoftenPortraitParams[] = [
  { softness: 5, lighting: 0, warmth: 10 },
  { softness: 2.5, lighting: -12, warmth: 18 },
];

const SHARPEN_PARAMETERS: readonly SharpenParams[] = [
  { amount: 2, threshold: 0 },
  { amount: 7, threshold: 0.15 },
];

const STRAIGHTEN_PARAMETERS: readonly StraightenParams[] = [
  { angle: 12, sampling: "bicubic" },
  { angle: -30, sampling: "bilinear" },
  { angle: 7.5, sampling: "nearestNeighbor" },
];

const VIGNETTE_PARAMETERS: readonly VignetteParams[] = [
  { center: { x: 0, y: 0 }, radius: 0.5, strength: 1 },
  { center: { x: 0.4, y: -0.3 }, radius: 1.5, strength: 0.6 },
];

describe.runIf(device !== undefined)("GpuStraighten and GpuVignette (WebGPU)", () => {
  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
  });

  it.each(STRAIGHTEN_PARAMETERS)(
    "Straighten matches the Rust reference within 1 for %o",
    async (params) => {
      const input = sample(17);
      const actual = await new GpuStraighten(device as GPUDevice).run(input, params);
      const expected = straightenCpu(input, params);
      expect(maxDifference(actual.data, expected.data)).toBeLessThanOrEqual(1);
    },
  );

  it.each(VIGNETTE_PARAMETERS)(
    "Vignette matches the Rust reference within 1 for %o",
    async (params) => {
      const input = sample(21);
      const actual = await new GpuVignette(device as GPUDevice).run(input, params);
      const expected = vignetteCpu(input, params);
      expect(maxDifference(actual.data, expected.data)).toBeLessThanOrEqual(1);
    },
  );
});

describe.runIf(device !== undefined)("GpuSharpen (WebGPU)", () => {
  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
  });

  it.each(SHARPEN_PARAMETERS)(
    "Sharpen matches the Rust reference within 1 for %o",
    async (params) => {
      const input = sample(13);
      const actual = await new GpuSharpen(device as GPUDevice).run(input, params);
      const expected = sharpenCpu(input, params);
      expect(maxDifference(actual.data, expected.data)).toBeLessThanOrEqual(1);
    },
  );
});

describe.runIf(device !== undefined)("GpuGlow and GpuSoftenPortrait (WebGPU)", () => {
  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
  });

  it.each(GLOW_PARAMETERS)("Glow matches the Rust reference within 1 for %o", async (params) => {
    const input = sample(5);
    const actual = await new GpuGlow(device as GPUDevice).run(input, params);
    const expected = glowCpu(input, params);
    expect(maxDifference(actual.data, expected.data)).toBeLessThanOrEqual(1);
  });

  it.each(SOFTEN_PARAMETERS)(
    "Soften Portrait matches the Rust reference within 1 for %o",
    async (params) => {
      const input = sample(9);
      const actual = await new GpuSoftenPortrait(device as GPUDevice).run(input, params);
      const expected = softenPortraitCpu(input, params);
      expect(maxDifference(actual.data, expected.data)).toBeLessThanOrEqual(1);
    },
  );
});
