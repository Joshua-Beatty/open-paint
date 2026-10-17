/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Surface } from "@openpaint/document";
import {
  type JuliaParams,
  juliaCpu,
  type MandelbrotParams,
  mandelbrotCpu,
} from "@openpaint/effects";
import { beforeAll, describe, expect, it } from "vitest";
import { initCpu } from "./cpu";
import { GpuJulia, GpuMandelbrot } from "./gpu-fractal";

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

const JULIA_PARAMETERS: readonly JuliaParams[] = [
  {
    factor: 4,
    zoom: 1,
    angle: 0,
    quality: 1,
    mode: 2,
    origin: undefined,
    document: undefined,
  },
  {
    factor: 2.5,
    zoom: 0.4,
    angle: 35,
    quality: 2,
    mode: 3,
    origin: { x: 6, y: 3 },
    document: { width: 64, height: 48 },
  },
];

const MANDELBROT_PARAMETERS: readonly MandelbrotParams[] = [
  {
    factor: 1,
    zoom: 10,
    angle: 0,
    quality: 1,
    mode: 2,
    invert: false,
    origin: undefined,
    document: undefined,
  },
  {
    factor: 3,
    zoom: 1.5,
    angle: -60,
    quality: 2,
    mode: 14,
    invert: true,
    origin: { x: 0, y: 0 },
    document: { width: 40, height: 24 },
  },
];

describe.runIf(device !== undefined)("GpuJulia (WebGPU)", () => {
  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
  });

  it.each(JULIA_PARAMETERS)("Julia matches the Rust reference within 1 for %o", async (params) => {
    const input = sample(19);
    const actual = await new GpuJulia(device as GPUDevice).run(input, params);
    const expected = juliaCpu(input, params);
    expect(maxDifference(actual.data, expected.data)).toBeLessThanOrEqual(1);
  });
});

describe.runIf(device !== undefined)("GpuMandelbrot (WebGPU)", () => {
  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
  });

  it.each(MANDELBROT_PARAMETERS)(
    "Mandelbrot matches the Rust reference within 1 for %o",
    async (params) => {
      const input = sample(63);
      const actual = await new GpuMandelbrot(device as GPUDevice).run(input, params);
      const expected = mandelbrotCpu(input, params);
      expect(maxDifference(actual.data, expected.data)).toBeLessThanOrEqual(1);
    },
  );
});
