/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Surface } from "@openpaint/document";
import { type BokehBlurParams, bokehBlurCpu } from "@openpaint/effects";
import { beforeAll, describe, expect, it } from "vitest";
import { initCpu } from "./cpu";
import { GpuBokehBlur } from "./gpu-bokeh-blur";

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
const WIDTH = 67;
const HEIGHT = 45;

/** A radius below 1 (pass-through), each quality, both gamma directions and a large disc. */
const PARAMETER_SETS: readonly BokehBlurParams[] = [
  { radius: 0.5, gammaBoost: 0, quality: 3 },
  { radius: 3, gammaBoost: 0, quality: 1 },
  { radius: 9, gammaBoost: 1.5, quality: 10 },
  { radius: 9, gammaBoost: -0.5, quality: 5 },
  { radius: 30, gammaBoost: 0.25, quality: 3 },
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

describe.runIf(device !== undefined)("GpuBokehBlur (WebGPU)", () => {
  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
  });

  it.each(PARAMETER_SETS)("matches the Rust reference within ±1 for %o", async (params) => {
    const blur = new GpuBokehBlur(device as GPUDevice);
    const input = noise(11, WIDTH, HEIGHT);
    const expected = bokehBlurCpu(input, params);
    const actual = await blur.run(input, params);
    expect(actual.width).toBe(WIDTH);
    expect(actual.height).toBe(HEIGHT);
    expect(maxDifference(actual.data, expected.data)).toBeLessThanOrEqual(1);
  });
});
