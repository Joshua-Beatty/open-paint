/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { rect, Surface, TiledPixelStore } from "@openpaint/document";
import { applyToRegion, type GaussianBlurParams, gaussianBlurCpu } from "@openpaint/effects";
import { beforeAll, describe, expect, it } from "vitest";
import { initCpu } from "./cpu";
import { GpuGaussianBlur } from "./gpu-gaussian-blur";

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

/** Radius 0 (pass-through), each quality level, both gamma directions and the downsample paths. */
const PARAMETER_SETS: readonly GaussianBlurParams[] = [
  { radius: 0, gammaBoost: 0, quality: 4 },
  { radius: 2, gammaBoost: 0, quality: 3 },
  { radius: 9, gammaBoost: 0, quality: 4 },
  { radius: 9, gammaBoost: 1.5, quality: 4 },
  { radius: 9, gammaBoost: -0.5, quality: 4 },
  { radius: 60, gammaBoost: 0.25, quality: 1 },
  { radius: 120, gammaBoost: 0, quality: 2 },
  { radius: 200, gammaBoost: 0, quality: 3 },
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

describe.runIf(device !== undefined)("GpuGaussianBlur (WebGPU)", () => {
  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
  });

  it.each(PARAMETER_SETS)("matches the Rust reference within ±1 for %o", async (params) => {
    const blur = new GpuGaussianBlur(device as GPUDevice);
    const input = noise(7, WIDTH, HEIGHT);
    const expected = gaussianBlurCpu(input, params);
    const actual = await blur.run(input, params);
    expect(actual.width).toBe(WIDTH);
    expect(actual.height).toBe(HEIGHT);
    expect(maxDifference(actual.data, expected.data)).toBeLessThanOrEqual(1);
  });

  it("blurs only the selected half of a layer region and leaves the rest untouched", async () => {
    const blur = new GpuGaussianBlur(device as GPUDevice);
    const store = new TiledPixelStore(WIDTH, HEIGHT);
    store.writeRegion(noise(9, WIDTH, HEIGHT), 0, 0);
    const region = rect(4, 3, 40, 30);
    const coverage = new Uint8ClampedArray(region.width * region.height);
    for (let y = 0; y < region.height; y++) {
      coverage.fill(255, y * region.width, y * region.width + 20);
    }
    const params: GaussianBlurParams = { radius: 4, gammaBoost: 0.5, quality: 4 };
    const before = store.readRegion(region);
    const expected = gaussianBlurCpu(before, params);

    await applyToRegion({
      store,
      region,
      coverage,
      run: (input) => blur.run(input, params),
    });

    const after = store.readRegion(region);
    for (let y = 0; y < region.height; y++) {
      for (let x = 0; x < region.width; x++) {
        const i = (y * region.width + x) * 4;
        const actual = after.data.subarray(i, i + 4);
        if (x < 20) {
          expect(maxDifference(actual, expected.data.subarray(i, i + 4))).toBeLessThanOrEqual(1);
        } else {
          expect([...actual]).toEqual([...before.data.subarray(i, i + 4)]);
        }
      }
    }
    expect(store.getPixel(0, 0)).toEqual(noise(9, WIDTH, HEIGHT).getPixel(0, 0));
  });
});
