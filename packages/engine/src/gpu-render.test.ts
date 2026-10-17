/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Surface } from "@openpaint/document";
import {
  type CloudsParams,
  cloudsCpu,
  type TurbulenceParams,
  turbulenceCpu,
} from "@openpaint/effects";
import { beforeAll, describe, expect, it } from "vitest";
import { initCpu } from "./cpu";
import { GpuClouds, GpuTurbulence } from "./gpu-render";

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

const CLOUDS_PARAMETERS: readonly CloudsParams[] = [
  {
    scale: 250,
    roughness: 0.5,
    mode: 0,
    seed: 0,
    color1: { r: 0, g: 0, b: 0, a: 1 },
    color2: { r: 1, g: 1, b: 1, a: 1 },
    origin: { x: 0, y: 0 },
    document: { width: 64, height: 48 },
  },
  {
    scale: 37,
    roughness: 0.8,
    mode: 3,
    seed: 201,
    color1: { r: 0.9, g: 0.2, b: 0.1, a: 0.6 },
    color2: { r: 0.1, g: 0.4, b: 1, a: 1 },
    origin: { x: 9, y: 5 },
    document: { width: 64, height: 48 },
  },
  {
    scale: 2,
    roughness: 1,
    mode: 14,
    seed: 17,
    color1: { r: 0.2, g: 0.8, b: 0.4, a: 1 },
    color2: { r: 0.8, g: 0.6, b: 0.2, a: 0.5 },
    origin: { x: 0, y: 0 },
    document: { width: 40, height: 24 },
  },
  {
    scale: 90,
    roughness: 0.4,
    mode: 43,
    seed: 3,
    color1: { r: 0.5, g: 0.1, b: 0.9, a: 1 },
    color2: { r: 0.9, g: 0.9, b: 0.2, a: 1 },
    origin: { x: 0, y: 0 },
    document: { width: 40, height: 24 },
  },
];

const TURBULENCE_PARAMETERS: readonly TurbulenceParams[] = [
  { octaves: 4, period: 100, tile: 4096, fractal: false, seed: 1, mode: 0, origin: undefined },
  { octaves: 6, period: 9, tile: 64, fractal: true, seed: 55, mode: 4, origin: { x: 13, y: 7 } },
  { octaves: 1, period: 0.5, tile: 16, fractal: false, seed: 200, mode: 35, origin: undefined },
  { octaves: 3, period: 40, tile: 128, fractal: true, seed: 9, mode: 44, origin: { x: 0, y: 0 } },
];

describe.runIf(device !== undefined)("GpuClouds (WebGPU)", () => {
  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
  });

  it.each(CLOUDS_PARAMETERS)(
    "Clouds matches the Rust reference within 1 for %o",
    async (params) => {
      const input = sample(31);
      const actual = await new GpuClouds(device as GPUDevice).run(input, params);
      const expected = cloudsCpu(input, params);
      expect(maxDifference(actual.data, expected.data)).toBeLessThanOrEqual(1);
    },
  );
});

describe.runIf(device !== undefined)("GpuTurbulence (WebGPU)", () => {
  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
  });

  it.each(TURBULENCE_PARAMETERS)(
    "Turbulence matches the Rust reference within 1 for %o",
    async (params) => {
      const input = sample(47);
      const actual = await new GpuTurbulence(device as GPUDevice).run(input, params);
      const expected = turbulenceCpu(input, params);
      expect(maxDifference(actual.data, expected.data)).toBeLessThanOrEqual(1);
    },
  );
});
