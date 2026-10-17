import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BOKEH_BLUR_ID,
  type BokehBlurPlan,
  bokehBlurBinding,
  bokehBlurCpu,
  bokehBlurDescriptor,
  bokehBlurParams,
  bokehBlurSchema,
  planBokehBlur,
} from "./bokeh-blur";
import { builtinEffectBindings } from "./index";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

/** An opaque black image with one white pixel at the center. */
function pointImage(width: number, height: number): Surface {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([0, 0, 0, 255], i * 4);
  const center = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
  data.set([255, 255, 255, 255], center);
  return new Surface(width, height, data);
}

/** The complex sum of a plan's kernel over its support, `Σ_k (Σ g_k)(Σ h_k)`. The kernel is its real part. */
function kernelSum(plan: BokehBlurPlan): { re: number; im: number } {
  const taps = 2 * plan.halfWidth + 1;
  const at = (weights: Float32Array, index: number) => weights[index] ?? 0;
  let re = 0;
  let im = 0;
  for (let term = 0; term < plan.terms; term++) {
    let g: [number, number] = [0, 0];
    let h: [number, number] = [0, 0];
    for (let t = 0; t < taps; t++) {
      const index = (term * taps + t) * 2;
      g = [g[0] + at(plan.vertical, index), g[1] + at(plan.vertical, index + 1)];
      h = [h[0] + at(plan.horizontal, index), h[1] + at(plan.horizontal, index + 1)];
    }
    re += g[0] * h[0] - g[1] * h[1];
    im += g[0] * h[1] + g[1] * h[0];
  }
  return { re, im };
}

describe("Bokeh Blur descriptor and schema", () => {
  it("is a configurable linear-light Blurs effect", () => {
    expect(bokehBlurDescriptor()).toMatchObject({
      id: BOKEH_BLUR_ID,
      label: "effect.bokehBlur",
      category: "effect",
      submenu: "blurs",
      configurable: true,
      kind: "gpuImage",
      options: { gpu: { workingSpace: "linear", inputAlpha: "straight" } },
    });
  });

  it("lists Radius, Gamma Boost and Quality with the spec's defaults and ranges", () => {
    const properties = bokehBlurSchema().properties;
    expect(properties.map((property) => property.key)).toEqual(["radius", "gammaBoost", "quality"]);
    expect(properties).toEqual([
      expect.objectContaining({ kind: "double", defaultValue: 25, min: 0, max: 300 }),
      expect.objectContaining({ kind: "double", defaultValue: 0, min: -0.99, max: 2 }),
      expect.objectContaining({ kind: "int32", defaultValue: 3, min: 1, max: 10 }),
    ]);
  });

  it("clamps stored values to the schema ranges", () => {
    expect(
      resolveValues(bokehBlurSchema(), { radius: 900, gammaBoost: -3, quality: 42 }),
    ).toMatchObject({ radius: 300, gammaBoost: -0.99, quality: 10 });
  });
});

describe("Bokeh Blur parameters, plan and CPU reference", () => {
  it("reads the defaults from empty values", () => {
    expect(bokehBlurParams({})).toEqual({ radius: 25, gammaBoost: 0, quality: 3 });
  });

  it("plans one vertical and one horizontal run of taps per term, with the kernel summing to 1", () => {
    for (const quality of [1, 3, 10]) {
      const plan = planBokehBlur({ radius: 7.25, gammaBoost: 0.5, quality });
      if (!plan) throw new Error("expected a Bokeh Blur plan");
      expect(plan.halfWidth).toBe(8);
      expect(plan.terms).toBe(quality);
      expect(plan.vertical.length).toBe(quality * 17 * 2);
      expect(plan.horizontal.length).toBe(quality * 17 * 2);
      expect(plan.exponent).toBeCloseTo(1.5, 6);
      expect(kernelSum(plan).re).toBeCloseTo(1, 3);
    }
  });

  it("plans nothing below radius 1", () => {
    expect(planBokehBlur({ radius: 0, gammaBoost: 0, quality: 3 })).toBeUndefined();
    expect(planBokehBlur({ radius: 0.5, gammaBoost: 0, quality: 3 })).toBeUndefined();
  });

  it("spreads one bright pixel into a flat disc at the center", () => {
    const out = bokehBlurCpu(pointImage(41, 41), { radius: 8, gammaBoost: 0, quality: 10 });
    const value = (x: number, y: number) => out.data[(y * 41 + x) * 4] ?? 0;
    const inside = [
      [20, 20],
      [22, 23],
      [24, 20],
      [25, 22],
      [23, 25],
    ] as const;
    const values = inside.map(([x, y]) => value(x, y));
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    expect(mean).toBeGreaterThan(0);
    for (const v of values) expect(Math.abs(v - mean)).toBeLessThan(0.15 * mean);
    expect(value(32, 20)).toBeLessThan(0.05 * mean);
  });

  it("leaves a uniform image unchanged", () => {
    const data = new Uint8ClampedArray(9 * 7 * 4);
    for (let i = 0; i < 63; i++) data.set([120, 60, 200, 255], i * 4);
    const uniform = new Surface(9, 7, data);
    const out = bokehBlurCpu(uniform, { radius: 3.5, gammaBoost: 0.5, quality: 4 });
    expect([...out.data]).toEqual([...uniform.data]);
  });

  it("returns the input below radius 1", () => {
    const input = pointImage(8, 4);
    const out = bokehBlurCpu(input, { radius: 0, gammaBoost: 0, quality: 3 });
    expect([...out.data]).toEqual([...input.data]);
  });
});

describe("Bokeh Blur binding", () => {
  it("reads its parameters from values and runs the CPU reference", () => {
    const binding = bokehBlurBinding();
    const params = binding.params({ gammaBoost: 1 }, { width: 8, height: 8 }, 0);
    expect(params).toEqual({ radius: 25, gammaBoost: 1, quality: 3 });
    expect(binding.cpu(pointImage(8, 6), params).height).toBe(6);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(BOKEH_BLUR_ID);
  });
});
