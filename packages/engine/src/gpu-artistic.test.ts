/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Surface } from "@openpaint/document";
import {
  type InkSketchParams,
  inkSketchCpu,
  type OilPaintingParams,
  oilPaintingCpu,
  type PencilSketchParams,
  pencilSketchCpu,
} from "@openpaint/effects";
import { beforeAll, describe, expect, it } from "vitest";
import { initCpu } from "./cpu";
import { GpuInkSketch, GpuOilPainting, GpuPencilSketch } from "./gpu-artistic";

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

const INK_PARAMETERS: readonly InkSketchParams[] = [
  { inkOutline: 50, coloring: 50 },
  { inkOutline: 20, coloring: 0 },
];

const OIL_PARAMETERS: readonly OilPaintingParams[] = [
  { brushSize: 4, granularity: 0.2, kernelShape: "circle" },
  { brushSize: 2, granularity: 0.5, kernelShape: "square" },
];

const PENCIL_PARAMETERS: readonly PencilSketchParams[] = [
  { tipSize: 2, range: 0 },
  { tipSize: 4, range: 10 },
];

describe.runIf(device !== undefined)(
  "GpuInkSketch, GpuOilPainting and GpuPencilSketch (WebGPU)",
  () => {
    beforeAll(async () => {
      const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
      await initCpu(await readFile(wasmPath));
    });

    it.each(INK_PARAMETERS)(
      "Ink Sketch matches the Rust reference within 1 for %o",
      async (params) => {
        const input = sample(3);
        const actual = await new GpuInkSketch(device as GPUDevice).run(input, params);
        const expected = inkSketchCpu(input, params);
        expect(maxDifference(actual.data, expected.data)).toBeLessThanOrEqual(1);
      },
    );

    it.each(OIL_PARAMETERS)(
      "Oil Painting matches the Rust reference within 1 for %o",
      async (params) => {
        const input = sample(7);
        const actual = await new GpuOilPainting(device as GPUDevice).run(input, params);
        const expected = oilPaintingCpu(input, params);
        expect(maxDifference(actual.data, expected.data)).toBeLessThanOrEqual(1);
      },
    );

    it.each(PENCIL_PARAMETERS)(
      "Pencil Sketch matches the Rust reference within 1 for %o",
      async (params) => {
        const input = sample(11);
        const actual = await new GpuPencilSketch(device as GPUDevice).run(input, params);
        const expected = pencilSketchCpu(input, params);
        expect(maxDifference(actual.data, expected.data)).toBeLessThanOrEqual(1);
      },
    );
  },
);
