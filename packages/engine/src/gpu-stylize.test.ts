/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Surface } from "@openpaint/document";
import {
  type EdgeDetectParams,
  type EmbossParams,
  edgeDetectCpu,
  embossCpu,
  type OutlineParams,
  outlineCpu,
  type ReliefParams,
  reliefCpu,
} from "@openpaint/effects";
import { beforeAll, describe, expect, it } from "vitest";
import { initCpu } from "./cpu";
import { GpuEdgeDetect, GpuEmboss, GpuOutline, GpuRelief } from "./gpu-stylize";

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

const EDGE_PARAMETERS: readonly EdgeDetectParams[] = [
  { strength: 0.5, blurring: 0, algorithm: "sobel", overlayEdges: false },
  { strength: 1, blurring: 3, algorithm: "prewitt", overlayEdges: false },
  { strength: 0.8, blurring: 1.5, algorithm: "sobel", overlayEdges: true },
];

const EMBOSS_PARAMETERS: readonly EmbossParams[] = [{ angle: 0 }, { angle: 135 }, { angle: 300 }];

const RELIEF_PARAMETERS: readonly ReliefParams[] = [{ angle: 45 }, { angle: -120 }, { angle: 170 }];

const OUTLINE_PARAMETERS: readonly OutlineParams[] = [
  { thickness: 3, intensity: 50, quality: 8 },
  { thickness: 2, intensity: 80, quality: 4 },
  { thickness: 1, intensity: 100, quality: 12 },
];

describe.runIf(device !== undefined)("Stylize on WebGPU", () => {
  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
  });

  it.each(EDGE_PARAMETERS)(
    "Edge Detect matches the Rust reference within 1 for %o",
    async (params) => {
      const input = sample(31);
      const actual = await new GpuEdgeDetect(device as GPUDevice).run(input, params);
      const expected = edgeDetectCpu(input, params);
      expect(maxDifference(actual.data, expected.data)).toBeLessThanOrEqual(1);
    },
  );

  it.each(EMBOSS_PARAMETERS)(
    "Emboss matches the Rust reference within 1 for %o",
    async (params) => {
      const input = sample(37);
      const actual = await new GpuEmboss(device as GPUDevice).run(input, params);
      const expected = embossCpu(input, params);
      expect(maxDifference(actual.data, expected.data)).toBeLessThanOrEqual(1);
    },
  );

  it.each(RELIEF_PARAMETERS)(
    "Relief matches the Rust reference within 1 for %o",
    async (params) => {
      const input = sample(41);
      const actual = await new GpuRelief(device as GPUDevice).run(input, params);
      const expected = reliefCpu(input, params);
      expect(maxDifference(actual.data, expected.data)).toBeLessThanOrEqual(1);
    },
  );

  it.each(OUTLINE_PARAMETERS)(
    "Outline matches the Rust reference within 1 for %o",
    async (params) => {
      const input = sample(43);
      const actual = await new GpuOutline(device as GPUDevice).run(input, params);
      const expected = outlineCpu(input, params);
      expect(maxDifference(actual.data, expected.data)).toBeLessThanOrEqual(1);
    },
  );
});
