/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BRIGHTNESS_CONTRAST_ID,
  BRIGHTNESS_CONTRAST_OP,
  brightnessContrastBinding,
  brightnessContrastCpu,
  brightnessContrastDescriptor,
  brightnessContrastParams,
  brightnessContrastPlan,
  brightnessContrastSchema,
} from "./brightness-contrast";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

/**
 * ADJ-BC-01 transcribed directly in floating point, for one color on 0..255 with its alpha. It
 * returns the channels on 0..255 before rounding.
 */
function specBrightnessContrast(
  color: readonly [number, number, number],
  brightness: number,
  contrast: number,
): number[] {
  const [r, g, b] = color.map((channel) => channel / 255);
  const y = 0.299 * (r ?? 0) + 0.587 * (g ?? 0) + 0.114 * (b ?? 0);
  const bright = brightness / 255;
  let mul = 1;
  let div = 1;
  if (contrast < 0) {
    mul = contrast + 100;
    div = 100;
  } else if (contrast > 0) {
    mul = 100;
    div = 100 - contrast;
  }
  if (div === 0) {
    const gray = y + bright >= 0.5 ? 255 : 0;
    return [gray, gray, gray];
  }
  const pre = div === 100 ? 0 : bright;
  const post = div === 100 ? bright : 0;
  const shift = ((y - 0.5 + pre) * mul) / div + (0.5 - y + post);
  return [r, g, b].map((channel) => Math.min(1, Math.max(0, (channel ?? 0) + shift)) * 255);
}

const COLORS: readonly (readonly [number, number, number])[] = [
  ...Array.from({ length: 16 }, (_, i) => [i * 17, i * 17, i * 17] as const),
  [200, 120, 40],
  [10, 90, 250],
];
const BRIGHTNESS = [-100, -37, 0, 25, 100];
const CONTRAST = [-100, -60, -1, 0, 1, 35, 80, 99, 100];

describe("Brightness / Contrast descriptor (ADJ-BC)", () => {
  it("is a configurable adjustment with Brightness and Contrast sliders from -100 to 100", () => {
    const descriptor = brightnessContrastDescriptor();
    expect(descriptor).toMatchObject({
      id: BRIGHTNESS_CONTRAST_ID,
      category: "adjustment",
      configurable: true,
      kind: "gpuImage",
    });
    const [brightness, contrast] = brightnessContrastSchema().properties;
    expect(brightness).toMatchObject({
      kind: "int32",
      key: "brightness",
      defaultValue: 0,
      min: -100,
      max: 100,
    });
    expect(contrast).toMatchObject({ kind: "int32", key: "contrast", defaultValue: 0 });
  });

  it("clamps stored values to the schema", () => {
    expect(brightnessContrastParams({ brightness: 500, contrast: -300 })).toEqual({
      brightness: 100,
      contrast: -100,
    });
    expect(brightnessContrastParams({ brightness: "x" })).toEqual({ brightness: 0, contrast: 0 });
    expect(resolveValues(brightnessContrastSchema(), {}).brightness).toBe(0);
  });
});

describe("Brightness / Contrast math (ADJ-BC-01)", () => {
  it("is the identity at 0 and 0", () => {
    const src = new Surface(
      COLORS.length,
      1,
      new Uint8ClampedArray(COLORS.flatMap(([r, g, b]) => [r, g, b, 180])),
    );
    expect([...brightnessContrastCpu(src, { brightness: 0, contrast: 0 }).data]).toEqual([
      ...src.data,
    ]);
  });

  it("matches the spec formula within ±1 for every parameter pair", () => {
    for (const brightness of BRIGHTNESS) {
      for (const contrast of CONTRAST) {
        const src = new Surface(
          COLORS.length,
          1,
          new Uint8ClampedArray(COLORS.flatMap(([r, g, b]) => [r, g, b, 77])),
        );
        const out = brightnessContrastCpu(src, { brightness, contrast });
        COLORS.forEach((color, i) => {
          const expected = specBrightnessContrast(color, brightness, contrast);
          for (let channel = 0; channel < 3; channel++) {
            const actual = out.data[i * 4 + channel] ?? 0;
            const want = Math.floor((expected[channel] ?? 0) + 0.5);
            expect(
              Math.abs(actual - want),
              `B ${brightness} C ${contrast} color ${i}`,
            ).toBeLessThanOrEqual(1);
          }
        });
      }
    }
  });

  it("keeps alpha, including for transparent pixels", () => {
    const src = new Surface(1, 1, new Uint8ClampedArray([60, 60, 60, 0]));
    expect(brightnessContrastCpu(src, { brightness: 80, contrast: 40 }).data[3]).toBe(0);
  });

  it("plans the shift, multiplier and divisor for the WGSL twin", () => {
    const plan = brightnessContrastPlan({ brightness: 100, contrast: -50 });
    expect(plan.op).toBe(BRIGHTNESS_CONTRAST_OP);
    expect([...plan.brightnessContrast]).toEqual([Math.fround(100 / 255), 50, 100]);
  });

  it("binds the parameter reader and the CPU reference", () => {
    const binding = brightnessContrastBinding();
    const src = new Surface(1, 1, new Uint8ClampedArray([120, 60, 30, 255]));
    expect([...binding.cpu(src, binding.params({ brightness: 20, contrast: 10 })).data]).toEqual([
      ...brightnessContrastCpu(src, { brightness: 20, contrast: 10 }).data,
    ]);
  });
});
