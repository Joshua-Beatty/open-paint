/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Surface } from "@openpaint/document";
import {
  type AddNoiseParams,
  addNoiseCpu,
  type ReduceNoiseParams,
  reduceNoiseCpu,
} from "@openpaint/effects";
import { beforeAll, describe, expect, it } from "vitest";
import { initCpu } from "./cpu";
import { GpuAddNoise, GpuReduceNoise } from "./gpu-noise";

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
/** Larger than one 128 px tile on both axes, so each run covers several tiles. */
const WIDTH = 300;
const HEIGHT = 200;

const ADD_PARAMETERS: readonly AddNoiseParams[] = [
  { intensity: 64, colorSaturation: 100, coverage: 100, userSeed: 0, instanceSeed: 0 },
  { intensity: 90, colorSaturation: 0, coverage: 45, userSeed: 200, instanceSeed: 0x77 },
];

const REDUCE_PARAMETERS: readonly ReduceNoiseParams[] = [
  { radius: 10, strength: 0.4 },
  { radius: 3, strength: 1 },
];

/** Deterministic noise with varied alpha, so every run exercises the same pixels. */
function noise(seed: number, width: number, height: number): Surface {
  let state = seed >>> 0;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    data[i] = state >>> 24;
  }
  return new Surface(width, height, data);
}

function maxDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return max;
}

describe.runIf(device !== undefined)("GpuAddNoise and GpuReduceNoise (WebGPU)", () => {
  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
  });

  it.each(ADD_PARAMETERS)(
    "Add Noise matches the Rust reference within 1 for %o",
    async (params) => {
      const input = noise(5, WIDTH, HEIGHT);
      const actual = await new GpuAddNoise(device as GPUDevice).run(input, params);
      const expected = addNoiseCpu(input, params);
      expect(actual.width).toBe(WIDTH);
      expect(maxDifference(actual.data, expected.data)).toBeLessThanOrEqual(1);
    },
  );

  it.each(REDUCE_PARAMETERS)(
    "Reduce Noise matches the Rust reference within 1 for %o",
    async (params) => {
      const input = noise(9, WIDTH, HEIGHT);
      const actual = await new GpuReduceNoise(device as GPUDevice).run(input, params);
      const expected = reduceNoiseCpu(input, params);
      expect(actual.height).toBe(HEIGHT);
      expect(maxDifference(actual.data, expected.data)).toBeLessThanOrEqual(1);
    },
  );
});
