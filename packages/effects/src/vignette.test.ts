/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import { SOURCE_UNDERLAY_KEY } from "./distortion";
import {
  builtinEffectBindings,
  planVignette,
  VIGNETTE_ID,
  vignetteBinding,
  vignetteCpu,
  vignetteDescriptor,
  vignetteParams,
  vignetteSchema,
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

describe("Vignette descriptor and schema", () => {
  it("is a configurable Photo effect that works in linear light", () => {
    expect(vignetteDescriptor()).toMatchObject({
      id: VIGNETTE_ID,
      label: "effect.vignette",
      category: "effect",
      submenu: "photo",
      configurable: true,
      kind: "gpuImage",
      options: { gpu: { workingSpace: "linear", inputAlpha: "straight" } },
    });
  });

  it("lists Center, Radius and Strength in that order, with the spec's defaults", () => {
    const properties = vignetteSchema().properties;
    expect(properties.map((property) => property.key)).toEqual(["center", "radius", "strength"]);
    expect(properties[0]).toMatchObject({
      kind: "vector2",
      defaultValue: { x: 0, y: 0 },
      min: { x: -1, y: -1 },
      max: { x: 1, y: 1 },
      control: { staticImageUnderlay: SOURCE_UNDERLAY_KEY },
    });
    expect(properties[1]).toMatchObject({
      kind: "double",
      defaultValue: 0.5,
      min: 0.1,
      max: 4,
    });
    expect(properties[2]).toMatchObject({ kind: "double", defaultValue: 1, min: 0, max: 1 });
  });

  it("uses the defaults and clamps the values to the schema", () => {
    expect(resolveValues(vignetteSchema(), {})).toMatchObject({
      radius: 0.5,
      strength: 1,
    });
    expect(vignetteParams({ center: { x: 3, y: -3 }, radius: 10, strength: -1 })).toEqual({
      center: { x: 1, y: -1 },
      radius: 4,
      strength: 0,
    });
  });
});

describe("Vignette plan", () => {
  it("puts the center in the middle of the region and scales the falloff by the radius", () => {
    const plan = planVignette({ center: { x: 0, y: 0 }, radius: 0.5, strength: 1 }, 40, 24);
    expect(plan[0]).toBe(20);
    expect(plan[1]).toBe(12);
    // Rmax is 0.5 · 40 · 0.5 = 10, so k = π / 800.
    expect(plan[2]).toBeCloseTo(Math.PI / 800, 6);
  });

  it("moves the center toward the edge at Center 1", () => {
    const plan = planVignette({ center: { x: 1, y: -1 }, radius: 0.5, strength: 1 }, 40, 24);
    expect(plan[0]).toBe(40);
    expect(plan[1]).toBe(0);
  });
});

describe("Vignette CPU reference", () => {
  it("leaves the image unchanged at Strength 0", () => {
    const input = flat(5, 3, [30, 90, 200, 180]);
    const out = vignetteCpu(input, {
      center: { x: 0, y: 0 },
      radius: 0.5,
      strength: 0,
    });
    expect([...out.data]).toEqual([...input.data]);
  });

  it("blacks out the corners at Strength 1 and keeps the center", () => {
    const out = vignetteCpu(flat(40, 24, [255, 255, 255, 255]), {
      center: { x: 0, y: 0 },
      radius: 0.5,
      strength: 1,
    });
    expect([...out.data.slice(0, 4)]).toEqual([0, 0, 0, 255]);
    const center = (12 * 40 + 20) * 4;
    expect([...out.data.slice(center, center + 4)]).toEqual([255, 255, 255, 255]);
  });

  it("keeps alpha", () => {
    const out = vignetteCpu(flat(6, 6, [200, 40, 40, 90]), {
      center: { x: 0, y: 0 },
      radius: 0.3,
      strength: 0.8,
    });
    for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(90);
  });
});

describe("Vignette binding", () => {
  it("runs the CPU reference from its parameters", () => {
    const binding = vignetteBinding();
    const out = binding.cpu(flat(4, 4, [51, 51, 51, 255]), binding.params({ radius: 2 }));
    expect(out.width).toBe(4);
    expect(out.height).toBe(4);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(VIGNETTE_ID);
  });
});
