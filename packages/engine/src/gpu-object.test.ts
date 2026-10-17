/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Surface } from "@openpaint/document";
import {
  ALIGN_POSITIONS,
  alignObjectCpu,
  type DropShadowParams,
  dropShadowCpu,
} from "@openpaint/effects";
import { beforeAll, describe, expect, it } from "vitest";
import { initCpu } from "./cpu";
import { GpuAlignObject, GpuDropShadow } from "./gpu-object";

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

/** A deterministic image with varied color, brightness and alpha, and a transparent border. */
function sample(seed: number): Surface {
  let state = seed >>> 0;
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let i = 0; i < data.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    data[i] = state >>> 24;
  }
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (x % 9 === 0 && y % 7 === 0) data[(y * WIDTH + x) * 4 + 3] = 0;
    }
  }
  return new Surface(WIDTH, HEIGHT, data);
}

function maxDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return max;
}

const PARAMETERS: readonly DropShadowParams[] = [
  { radius: 10, distance: 10, angle: -45, opacity: 0.75, color: 0, onlyShadow: false },
  { radius: 2.5, distance: 6.5, angle: 120, opacity: 0.5, color: 0x30_60_ff, onlyShadow: false },
  { radius: 6, distance: 8, angle: 0, opacity: 1, color: 0x40_20_00, onlyShadow: true },
];

describe.runIf(device !== undefined)("Drop Shadow on WebGPU", () => {
  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
  });

  it.each(PARAMETERS)("matches the Rust reference within 1 for %o", async (params) => {
    const input = sample(47);
    const actual = await new GpuDropShadow(device as GPUDevice).run(input, params);
    const expected = dropShadowCpu(input, params);
    expect(maxDifference(actual.data, expected.data)).toBeLessThanOrEqual(1);
  });
});

/** A transparent image with a small object of varied colors and alphas, faint pixels included. */
function objectImage(): Surface {
  const input = sample(11);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const inside = x >= 7 && x < 15 && y >= 5 && y < 11;
      if (!inside) input.data[(y * WIDTH + x) * 4 + 3] = 0;
      else if ((x + y) % 5 === 0) input.data[(y * WIDTH + x) * 4 + 3] = 1;
    }
  }
  return input;
}

/** Selected inside a disc, so the selection is not a rectangle. */
function discCoverage(): Uint8Array {
  const coverage = new Uint8Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if ((x - 14) ** 2 + (y - 11) ** 2 <= 110) coverage[y * WIDTH + x] = 255;
    }
  }
  return coverage;
}

describe.runIf(device !== undefined)("Align Object on WebGPU", () => {
  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
  });

  it.each(ALIGN_POSITIONS)("matches the Rust reference exactly for %s", async (position) => {
    const input = objectImage();
    for (const coverage of [undefined, discCoverage()]) {
      for (const showFaintPixels of [false, true]) {
        const params = { position, showFaintPixels };
        const actual = await new GpuAlignObject(device as GPUDevice).run(input, params, coverage);
        const expected = alignObjectCpu(input, params, coverage);
        expect(maxDifference(actual.data, expected.data)).toBe(0);
      }
    }
  });
});
