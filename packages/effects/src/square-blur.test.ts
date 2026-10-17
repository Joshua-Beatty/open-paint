import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import { builtinEffectBindings } from "./index";
import {
  planSquareBlur,
  SQUARE_BLUR_ID,
  squareBlurBinding,
  squareBlurCpu,
  squareBlurDescriptor,
  squareBlurParams,
  squareBlurSchema,
} from "./square-blur";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

/** An opaque image: black on the left half, white on the right half. */
function stepImage(width: number, height: number): Surface {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = x < width / 2 ? 0 : 255;
      data.set([value, value, value, 255], (y * width + x) * 4);
    }
  }
  return new Surface(width, height, data);
}

describe("Square Blur descriptor and schema", () => {
  it("is a configurable linear-light Blurs effect", () => {
    expect(squareBlurDescriptor()).toMatchObject({
      id: SQUARE_BLUR_ID,
      label: "effect.squareBlur",
      category: "effect",
      submenu: "blurs",
      configurable: true,
      kind: "gpuImage",
      options: { gpu: { workingSpace: "linear", inputAlpha: "straight" } },
    });
  });

  it("lists Radius and Gamma Boost, with the spec's defaults and ranges", () => {
    const properties = squareBlurSchema().properties;
    expect(properties.map((property) => property.key)).toEqual(["radius", "gammaBoost"]);
    expect(properties).toEqual([
      expect.objectContaining({ kind: "double", defaultValue: 6, min: 0, max: 300 }),
      expect.objectContaining({ kind: "double", defaultValue: 0, min: -0.99, max: 2 }),
    ]);
  });

  it("clamps stored values to the schema ranges", () => {
    expect(resolveValues(squareBlurSchema(), { radius: 900, gammaBoost: -3 })).toMatchObject({
      radius: 300,
      gammaBoost: -0.99,
    });
  });
});

describe("Square Blur parameters, plan and CPU reference", () => {
  it("reads the defaults from empty values", () => {
    expect(squareBlurParams({})).toEqual({ radius: 6, gammaBoost: 0 });
  });

  it("plans box weights that sum to 1, and no plan at radius 0", () => {
    const plan = planSquareBlur({ radius: 2.5, gammaBoost: 0.5 });
    expect(plan?.factor).toBe(1);
    expect(plan?.exponent).toBeCloseTo(1.5, 6);
    expect(plan?.kernel.length).toBe(7);
    expect(Array.from(plan?.kernel ?? []).reduce((sum, w) => sum + w, 0)).toBeCloseTo(1, 6);
    expect(planSquareBlur({ radius: 0, gammaBoost: 0 })).toBeUndefined();
  });

  it("keeps a sharp step edge", () => {
    const out = squareBlurCpu(stepImage(16, 6), { radius: 2, gammaBoost: 0 });
    expect(out.data[(3 * 16 + 2) * 4]).toBe(0);
    expect(out.data[(3 * 16 + 13) * 4]).toBe(255);
    expect(out.data[(3 * 16 + 7) * 4]).toBeGreaterThan(0);
    expect(out.data[(3 * 16 + 7) * 4]).toBeLessThan(255);
  });

  it("leaves a uniform image unchanged", () => {
    const data = new Uint8ClampedArray(9 * 7 * 4);
    for (let i = 0; i < 63; i++) data.set([120, 60, 200, 255], i * 4);
    const uniform = new Surface(9, 7, data);
    const out = squareBlurCpu(uniform, { radius: 2.5, gammaBoost: 0.5 });
    expect([...out.data]).toEqual([...uniform.data]);
  });

  it("returns the input at radius 0", () => {
    const input = stepImage(8, 4);
    const out = squareBlurCpu(input, { radius: 0, gammaBoost: 0 });
    expect([...out.data]).toEqual([...input.data]);
  });
});

describe("Square Blur binding", () => {
  it("reads its parameters from values and runs the CPU reference", () => {
    const binding = squareBlurBinding();
    const params = binding.params({ gammaBoost: 1 }, { width: 8, height: 8 }, 0);
    expect(params).toEqual({ radius: 6, gammaBoost: 1 });
    expect(binding.cpu(stepImage(8, 6), params).height).toBe(6);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(SQUARE_BLUR_ID);
  });
});
