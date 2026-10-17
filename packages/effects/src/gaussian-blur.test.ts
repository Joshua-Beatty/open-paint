/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { EffectRegistry } from "@openpaint/extension-api";
import { beforeAll, describe, expect, it } from "vitest";
import {
  gaussianBlurCpu,
  gaussianBlurDescriptor,
  gaussianBlurParams,
  gaussianBlurSchema,
  planGaussianBlur,
} from "./gaussian-blur";
import { registerBuiltinEffects } from "./index";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

function solid(width: number, height: number, pixel: number[]): Surface {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(pixel, i);
  return new Surface(width, height, data);
}

describe("Gaussian Blur schema", () => {
  it("defaults Quality to 3 when the factory level is 1 and to 4 otherwise", () => {
    const quality = (factory: 1 | 2) =>
      gaussianBlurSchema(factory).properties.find((property) => property.key === "quality")
        ?.defaultValue;
    expect(quality(1)).toBe(3);
    expect(quality(2)).toBe(4);
  });

  it("declares Radius, Gamma Boost and Quality with the FX-BLUR-GAUSS-02 ranges", () => {
    const byKey = Object.fromEntries(
      gaussianBlurSchema(2).properties.map((property) => [property.key, property]),
    );
    expect(byKey.radius).toMatchObject({ kind: "double", defaultValue: 2, min: 0, max: 300 });
    expect(byKey.gammaBoost).toMatchObject({ kind: "double", defaultValue: 0, min: -0.99, max: 2 });
    expect(byKey.quality).toMatchObject({ kind: "int32", min: 1, max: 4 });
  });

  it("clamps parameter sets to the schema", () => {
    expect(gaussianBlurParams({ radius: 500, gammaBoost: -3, quality: 9 })).toEqual({
      radius: 300,
      gammaBoost: -0.99,
      quality: 4,
    });
  });

  it("registers as a linear-space Blurs effect", () => {
    const registry = new EffectRegistry();
    registerBuiltinEffects(registry, 1);
    expect(registry.get("gaussian-blur")).toEqual(gaussianBlurDescriptor(1));
    expect(gaussianBlurDescriptor(1)).toMatchObject({
      submenu: "blurs",
      category: "effect",
      configurable: true,
      kind: "gpuImage",
      options: { gpu: { workingSpace: "linear" } },
    });
  });
});

describe("Gaussian Blur plan", () => {
  it("passes a zero radius through", () => {
    expect(planGaussianBlur({ radius: 0, gammaBoost: 0, quality: 4 })).toBeUndefined();
    expect(planGaussianBlur({ radius: 9, gammaBoost: 0, quality: 4 })?.clamp).toBe(false);
    expect(planGaussianBlur({ radius: 9, gammaBoost: 0, quality: 4 }, "clamp")?.clamp).toBe(true);
  });

  it("uses σ = radius / 3 with a kernel spanning ceil(3σ) on each side", () => {
    const plan = planGaussianBlur({ radius: 9, gammaBoost: 1, quality: 4 });
    expect(plan?.factor).toBe(1);
    expect(plan?.kernel.length).toBe(2 * 9 + 1);
    expect(plan?.exponent).toBe(2);
  });

  it("downsamples at quality 1 once σ exceeds 16", () => {
    const plan = planGaussianBlur({ radius: 60, gammaBoost: 0, quality: 1 });
    expect(plan?.factor).toBe(4);
    // The blur runs at σ / 4 = 5 on the downsampled image, so R = 15.
    expect(plan?.kernel.length).toBe(2 * 15 + 1);
    expect(planGaussianBlur({ radius: 30, gammaBoost: 0, quality: 1 })?.factor).toBe(1);
  });
});

describe("Gaussian Blur Rust reference", () => {
  it("returns the input unchanged for radius 0", () => {
    const input = solid(5, 3, [12, 200, 77, 130]);
    expect(gaussianBlurCpu(input, { radius: 0, gammaBoost: 0.5, quality: 3 }).data).toEqual(
      input.data,
    );
  });

  it("keeps a uniform image uniform", () => {
    const input = solid(20, 12, [90, 140, 255, 255]);
    const out = gaussianBlurCpu(input, { radius: 6, gammaBoost: 0.4, quality: 4 });
    expect(out.data).toEqual(input.data);
  });

  it("keeps transparent pixels transparent", () => {
    const input = solid(6, 6, [0, 0, 0, 0]);
    expect(gaussianBlurCpu(input, { radius: 4, gammaBoost: 0, quality: 2 }).isTransparent()).toBe(
      true,
    );
  });
});
