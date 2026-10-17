/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Surface } from "@openpaint/document";
import { beforeAll, describe, expect, it } from "vitest";
import { strokeBrushCpu } from "./brush";
import { BrushSettings, initCpu } from "./cpu";
import { GpuBrush } from "./gpu-brush";

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

/** A smoothed stroke with pressure changes that crosses the canvas edge. */
const STROKE = new Float32Array([-3, 6, 0.2, 30, 10, 0.6, 52, 40, 1, 60, 20, 0.4, 20, 38, 0.8]);

const CASES: Record<string, Partial<BrushSettings>> = {
  "default brush": {},
  "soft circle": { size: 9, hardness: 0.3 },
  "aliased circle": { size: 7, antialias: false },
  "hard square": { size: 11, square: true, hardness: 0.5 },
  erase: { erase: true, size: 12 },
  overwrite: { blend: 14, r: 20, g: 200, b: 90, a: 180, size: 8 },
  multiply: { blend: 1, r: 200, g: 120, b: 40, a: 200, size: 14 },
  "pressure off": { pressure: false, size: 10 },
};

/** Deterministic noise with varied alpha, so every run exercises the same pixels. */
function noise(seed: number): Surface {
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

describe.runIf(device !== undefined)("GpuBrush (WebGPU)", () => {
  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
  });

  it.each(Object.entries(CASES))(
    "matches the Rust reference within ±1 for %s",
    async (_, settings) => {
      const brush = Object.assign(new BrushSettings(), settings);
      const input = noise(11);
      const expected = strokeBrushCpu(input, STROKE, brush);
      const actual = await new GpuBrush(device as GPUDevice).run(input, STROKE, brush);
      expect(actual.width).toBe(WIDTH);
      expect(actual.height).toBe(HEIGHT);
      expect(maxDifference(actual.data, expected.data)).toBeLessThanOrEqual(1);
    },
  );

  it("returns a copy of the input when the path has no dabs", async () => {
    const input = noise(3);
    const actual = await new GpuBrush(device as GPUDevice).run(
      input,
      new Float32Array(0),
      new BrushSettings(),
    );
    expect([...actual.data]).toEqual([...input.data]);
  });
});
