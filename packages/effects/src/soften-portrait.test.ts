/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  builtinEffectBindings,
  planSoftenPortrait,
  SOFTEN_PORTRAIT_ID,
  softenPortraitBinding,
  softenPortraitCpu,
  softenPortraitDescriptor,
  softenPortraitParams,
  softenPortraitSchema,
} from "./index";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

function flat(width: number, height: number, rgba: readonly number[]): Surface {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return new Surface(width, height, data);
}

describe("Soften Portrait descriptor and schema", () => {
  it("is a configurable Photo effect in document space", () => {
    expect(softenPortraitDescriptor()).toMatchObject({
      id: SOFTEN_PORTRAIT_ID,
      label: "effect.softenPortrait",
      category: "effect",
      submenu: "photo",
      configurable: true,
      kind: "gpuImage",
      options: { gpu: { workingSpace: "document", inputAlpha: "straight" } },
    });
  });

  it("lists Softness, Lighting and Warmth with the spec's ranges and defaults", () => {
    const find = (key: string) => softenPortraitSchema().properties.find((p) => p.key === key);
    expect(find("softness")).toMatchObject({ kind: "double", defaultValue: 5, min: 0, max: 10 });
    expect(find("lighting")).toMatchObject({ kind: "int32", defaultValue: 0, min: -20, max: 20 });
    expect(find("warmth")).toMatchObject({ kind: "int32", defaultValue: 10, min: 0, max: 20 });
  });

  it("uses the defaults and clamps the values to the schema", () => {
    expect(resolveValues(softenPortraitSchema(), {})).toMatchObject({
      softness: 5,
      lighting: 0,
      warmth: 10,
    });
    expect(softenPortraitParams({ softness: 40, lighting: -50, warmth: 99 })).toEqual({
      softness: 10,
      lighting: -20,
      warmth: 20,
    });
  });
});

describe("Soften Portrait plan", () => {
  it("blurs with radius Softness times 3 times 1.25 in high quality", () => {
    const plan = planSoftenPortrait({ softness: 4, lighting: 0, warmth: 10 });
    expect(plan.blurRadius).toBe(15);
    expect(plan.blurQuality).toBe(4);
  });

  it("uses Lighting as the brightness and minus half of it as the contrast", () => {
    // Lighting 20 is brightness 20 and contrast -10, which is multiplier 90 over divisor 100.
    const plan = planSoftenPortrait({ softness: 5, lighting: 20, warmth: 10 });
    expect([...plan.plan]).toEqual([Math.fround(20 / 255), 90, 100]);
    expect(plan.warmth).toBe(10);
  });
});

describe("Soften Portrait CPU reference", () => {
  it("keeps flat white and flat black", () => {
    const white = softenPortraitCpu(flat(3, 3, [255, 255, 255, 255]), {
      softness: 5,
      lighting: 0,
      warmth: 20,
    });
    expect([...white.data.slice(0, 4)]).toEqual([255, 255, 255, 255]);
    const black = softenPortraitCpu(flat(3, 3, [0, 0, 0, 255]), {
      softness: 5,
      lighting: 0,
      warmth: 20,
    });
    expect([...black.data.slice(0, 4)]).toEqual([0, 0, 0, 255]);
  });

  it("warms a neutral gray", () => {
    const out = softenPortraitCpu(flat(4, 4, [128, 128, 128, 255]), {
      softness: 5,
      lighting: 0,
      warmth: 20,
    });
    expect(out.data[0]).toBeGreaterThan(out.data[1] ?? 0);
    expect(out.data[1]).toBeGreaterThan(out.data[2] ?? 0);
  });

  it("leaves transparent pixels transparent", () => {
    const out = softenPortraitCpu(flat(3, 3, [90, 90, 90, 0]), {
      softness: 5,
      lighting: 0,
      warmth: 10,
    });
    expect(out.data.every((value, i) => i % 4 !== 3 || value === 0)).toBe(true);
  });
});

describe("Soften Portrait binding", () => {
  it("runs the CPU reference from its parameters", () => {
    const binding = softenPortraitBinding();
    const out = binding.cpu(flat(4, 4, [51, 51, 51, 255]), binding.params({ warmth: 0 }));
    expect(out.width).toBe(4);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(SOFTEN_PORTRAIT_ID);
  });
});
