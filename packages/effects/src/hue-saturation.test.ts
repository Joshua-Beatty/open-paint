/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  HUE_SATURATION_ID,
  HUE_SATURATION_OP,
  type HueSaturationParams,
  hueSaturationBinding,
  hueSaturationCpu,
  hueSaturationDescriptor,
  hueSaturationParams,
  hueSaturationPlan,
  hueSaturationSchema,
} from "./hue-saturation";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

/**
 * ADJ-HUESAT-01 transcribed in floating point for one color on 0..255. It returns the channels on
 * 0..255 before rounding.
 */
function specHueSaturation(
  color: readonly [number, number, number],
  hue: number,
  saturation: number,
  lightness: number,
): number[] {
  const [r = 0, g = 0, b = 0] = color.map((channel) => channel / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  const wrapped = (((h + hue / 360) % 1) + 1) % 1;
  const factor = saturation <= 100 ? saturation / 100 : 1 + 3 * (saturation / 100 - 1);
  const sat = Math.min(1, Math.max(0, s * factor));
  const [nr, ng, nb] = hslToRgb(wrapped, sat, l);
  const t = Math.abs(lightness) / 100;
  const target = lightness >= 0 ? 1 : 0;
  return [nr, ng, nb].map((c) => (c + (target - c) * t) * 255);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (offset: number): number => {
    let t = h + offset;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [channel(1 / 3), channel(0), channel(-1 / 3)];
}

const COLORS: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [255, 255, 255],
  [128, 128, 128],
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [200, 120, 40],
  [10, 90, 250],
  [30, 200, 180],
  [240, 60, 200],
  [90, 90, 20],
];
const HUE = [-180, -60, 0, 45, 180];
const SATURATION = [0, 50, 100, 150, 200];
const LIGHTNESS = [-100, -20, 0, 35, 100];

function surfaceOf(colors: readonly (readonly [number, number, number])[], alpha: number): Surface {
  return new Surface(
    colors.length,
    1,
    new Uint8ClampedArray(colors.flatMap(([r, g, b]) => [r, g, b, alpha])),
  );
}

describe("Hue / Saturation descriptor (ADJ-HUESAT)", () => {
  it("is a configurable adjustment with the three sliders from the spec table", () => {
    expect(hueSaturationDescriptor()).toMatchObject({
      id: HUE_SATURATION_ID,
      category: "adjustment",
      configurable: true,
      kind: "gpuImage",
    });
    const [hue, saturation, lightness] = hueSaturationSchema().properties;
    expect(hue).toMatchObject({
      kind: "int32",
      key: "hue",
      defaultValue: 0,
      min: -180,
      max: 180,
      control: { controlStyle: "hueCentered", rangeWraps: true },
    });
    expect(saturation).toMatchObject({
      kind: "int32",
      key: "saturation",
      defaultValue: 100,
      min: 0,
      max: 200,
      control: { controlStyle: "saturationHue" },
    });
    expect(lightness).toMatchObject({ kind: "int32", key: "lightness", defaultValue: 0 });
    expect(lightness).toMatchObject({ min: -100, max: 100 });
  });

  it("clamps stored values to the schema", () => {
    expect(hueSaturationParams({ hue: 400, saturation: -5, lightness: 250 })).toEqual({
      hue: 180,
      saturation: 0,
      lightness: 100,
    });
    expect(hueSaturationParams({ hue: "x" })).toEqual({ hue: 0, saturation: 100, lightness: 0 });
    expect(resolveValues(hueSaturationSchema(), {}).saturation).toBe(100);
  });
});

describe("Hue / Saturation math (ADJ-HUESAT-01)", () => {
  it("is the identity at hue 0, saturation 100 and lightness 0", () => {
    const src = surfaceOf(COLORS, 180);
    expect([...hueSaturationCpu(src, { hue: 0, saturation: 100, lightness: 0 }).data]).toEqual([
      ...src.data,
    ]);
  });

  it("matches the spec formula within ±1 for every parameter combination", () => {
    for (const hue of HUE) {
      for (const saturation of SATURATION) {
        for (const lightness of LIGHTNESS) {
          const params: HueSaturationParams = { hue, saturation, lightness };
          const out = hueSaturationCpu(surfaceOf(COLORS, 77), params);
          COLORS.forEach((color, i) => {
            const expected = specHueSaturation(color, hue, saturation, lightness);
            for (let channel = 0; channel < 3; channel++) {
              const actual = out.data[i * 4 + channel] ?? 0;
              const want = Math.floor((expected[channel] ?? 0) + 0.5);
              expect(
                Math.abs(actual - want),
                `H ${hue} S ${saturation} L ${lightness} color ${i}`,
              ).toBeLessThanOrEqual(1);
            }
          });
        }
      }
    }
  });

  it("keeps alpha, including for transparent pixels", () => {
    const src = new Surface(1, 1, new Uint8ClampedArray([60, 20, 200, 0]));
    const out = hueSaturationCpu(src, { hue: 90, saturation: 150, lightness: 30 });
    expect(out.data[3]).toBe(0);
  });

  it("plans the hue turn, saturation factor, lightness weight and target for the WGSL twin", () => {
    const plan = hueSaturationPlan({ hue: 90, saturation: 150, lightness: -40 });
    expect(plan.op).toBe(HUE_SATURATION_OP);
    expect([...plan.hueSaturation]).toEqual([0.25, 2.5, Math.fround(0.4), 0]);
  });

  it("binds the parameter reader and the CPU reference", () => {
    const binding = hueSaturationBinding();
    const src = new Surface(1, 1, new Uint8ClampedArray([120, 60, 30, 255]));
    const params = binding.params({ hue: 20, saturation: 130, lightness: 10 });
    expect([...binding.cpu(src, params).data]).toEqual([
      ...hueSaturationCpu(src, { hue: 20, saturation: 130, lightness: 10 }).data,
    ]);
  });
});
