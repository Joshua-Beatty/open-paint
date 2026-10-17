/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Surface } from "@openpaint/document";
import {
  type AdjustmentId,
  type AdjustmentPlan,
  adjustmentCpu,
  autoLevelCpu,
  autoLevelPlan,
  brightnessContrastCpu,
  brightnessContrastPlan,
  exposureCpu,
  exposurePlan,
  highlightsShadowsCpu,
  highlightsShadowsPlan,
  hueSaturationCpu,
  hueSaturationPlan,
  levelsCpu,
  levelsPlan,
  planAdjustment,
  posterizeCpu,
  posterizePlan,
  temperatureTintCpu,
  temperatureTintPlan,
} from "@openpaint/effects";
import { beforeAll, describe, expect, it } from "vitest";
import { initCpu } from "./cpu";
import { GpuAdjustment } from "./gpu-adjustment";

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

interface AdjustmentCase {
  readonly name: string;
  /** The Rust reference for the same input. */
  readonly cpu: (input: Surface) => Surface;
  /** The plan the WGSL twin runs. */
  readonly plan: (input: Surface) => AdjustmentPlan;
}

function point(id: AdjustmentId, intensity: number): AdjustmentCase {
  return {
    name: `${id} at ${intensity}`,
    cpu: (input) => adjustmentCpu(id, input, intensity),
    plan: () => planAdjustment(id, intensity),
  };
}

/** Every adjustment, with Sepia at its ends and between them, and the selection-limited Auto-Level. */
const LEVELS_SAMPLE = {
  inputBlack: [0.1, 0, 0.2],
  inputWhite: [0.9, 1, 0.7],
  gamma: [1.5, 0.6, 1],
  outputBlack: [0, 0.1, 0],
  outputWhite: [1, 0.8, 0.9],
} as const;

const CASES: readonly AdjustmentCase[] = [
  {
    name: "levels",
    cpu: (input) => levelsCpu(input, LEVELS_SAMPLE),
    plan: () => levelsPlan(LEVELS_SAMPLE),
  },
  point("invertColors", 50),
  point("invertAlpha", 50),
  point("blackAndWhite", 50),
  point("sepia", 0),
  point("sepia", 37),
  point("sepia", 100),
  {
    name: "autoLevel",
    cpu: (input) => autoLevelCpu(input),
    plan: (input) => autoLevelPlan(input),
  },
  {
    name: "autoLevel over a selection",
    cpu: (input) => autoLevelCpu(input, selection()),
    plan: (input) => autoLevelPlan(input, selection()),
  },
  {
    name: "brightnessContrast 30 -40",
    cpu: (input) => brightnessContrastCpu(input, { brightness: 30, contrast: -40 }),
    plan: () => brightnessContrastPlan({ brightness: 30, contrast: -40 }),
  },
  {
    name: "brightnessContrast 0 100",
    cpu: (input) => brightnessContrastCpu(input, { brightness: 0, contrast: 100 }),
    plan: () => brightnessContrastPlan({ brightness: 0, contrast: 100 }),
  },
  {
    name: "hueSaturation 70 100 0",
    cpu: (input) => hueSaturationCpu(input, { hue: 70, saturation: 100, lightness: 0 }),
    plan: () => hueSaturationPlan({ hue: 70, saturation: 100, lightness: 0 }),
  },
  {
    name: "hueSaturation -150 170 -30",
    cpu: (input) => hueSaturationCpu(input, { hue: -150, saturation: 170, lightness: -30 }),
    plan: () => hueSaturationPlan({ hue: -150, saturation: 170, lightness: -30 }),
  },
  {
    name: "posterize 5 7 0 4",
    cpu: (input) => posterizeCpu(input, { levels: [5, 7, 0, 4] }),
    plan: () => posterizePlan({ levels: [5, 7, 0, 4] }),
  },
  {
    name: "exposure 60",
    cpu: (input) => exposureCpu(input, { exposure: 60 }),
    plan: () => exposurePlan({ exposure: 60 }),
  },
  {
    name: "temperatureTint 60 -30",
    cpu: (input) => temperatureTintCpu(input, { temperature: 60, tint: -30 }),
    plan: () => temperatureTintPlan({ temperature: 60, tint: -30 }),
  },
  {
    name: "highlightsShadows 60 -40 30 radius 4",
    cpu: (input) =>
      highlightsShadowsCpu(input, { highlights: 60, shadows: -40, clarity: 30, radius: 4 }),
    plan: () => highlightsShadowsPlan({ highlights: 60, shadows: -40, clarity: 30, radius: 4 }),
  },
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

/** Every third pixel is selected. */
function selection(): Uint8Array {
  return Uint8Array.from({ length: WIDTH * HEIGHT }, (_, i) => (i % 3 === 0 ? 255 : 0));
}

function maxDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return max;
}

describe.runIf(device !== undefined)("GpuAdjustment (WebGPU)", () => {
  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
  });

  it.each(CASES)("$name matches the Rust reference within ±1", async (kase) => {
    const adjustments = new GpuAdjustment(device as GPUDevice);
    const input = noise(11, WIDTH, HEIGHT);
    const expected = kase.cpu(input);
    const actual = await adjustments.run(input, kase.plan(input));
    expect(actual.width).toBe(WIDTH);
    expect(actual.height).toBe(HEIGHT);
    expect(maxDifference(actual.data, expected.data)).toBeLessThanOrEqual(1);
  });
});
