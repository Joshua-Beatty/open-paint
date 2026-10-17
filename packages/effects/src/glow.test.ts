/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  builtinEffectBindings,
  GLOW_ID,
  glowBinding,
  glowCpu,
  glowDescriptor,
  glowParams,
  glowSchema,
  planGlow,
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

describe("Glow descriptor and schema", () => {
  it("is a configurable Photo effect in document space", () => {
    expect(glowDescriptor()).toMatchObject({
      id: GLOW_ID,
      label: "effect.glow",
      category: "effect",
      submenu: "photo",
      configurable: true,
      kind: "gpuImage",
      options: { gpu: { workingSpace: "document", inputAlpha: "straight" } },
    });
  });

  it("lists Radius, Brightness and Contrast with the spec's ranges and defaults", () => {
    const find = (key: string) => glowSchema().properties.find((p) => p.key === key);
    expect(find("radius")).toMatchObject({ kind: "double", defaultValue: 6, min: 1, max: 20 });
    expect(find("brightness")).toMatchObject({
      kind: "int32",
      defaultValue: 10,
      min: -100,
      max: 100,
    });
    expect(find("contrast")).toMatchObject({
      kind: "int32",
      defaultValue: 10,
      min: -100,
      max: 100,
    });
  });

  it("uses the defaults and clamps the values to the schema", () => {
    expect(resolveValues(glowSchema(), {})).toMatchObject({
      radius: 6,
      brightness: 10,
      contrast: 10,
    });
    expect(glowParams({ radius: 50, brightness: -300, contrast: 300 })).toEqual({
      radius: 20,
      brightness: -100,
      contrast: 100,
    });
  });
});

describe("Glow plan", () => {
  it("blurs with radius Radius times 1.25 in high quality", () => {
    const plan = planGlow({ radius: 6, brightness: 10, contrast: 10 });
    expect(plan.blurRadius).toBe(7.5);
    expect(plan.blurQuality).toBe(4);
  });

  it("gives the Brightness / Contrast plan of its values", () => {
    expect([...planGlow({ radius: 6, brightness: 0, contrast: 0 }).plan]).toEqual([0, 1, 1]);
  });
});

describe("Glow CPU reference", () => {
  it("brightens a flat gray", () => {
    const out = glowCpu(flat(4, 4, [128, 128, 128, 255]), {
      radius: 3,
      brightness: 0,
      contrast: 0,
    });
    expect(out.data[0]).toBeGreaterThan(128);
    expect(out.data[3]).toBe(255);
  });

  it("keeps transparent pixels transparent", () => {
    const out = glowCpu(flat(3, 3, [90, 90, 90, 0]), { radius: 3, brightness: 10, contrast: 10 });
    expect(out.data.every((value, i) => i % 4 !== 3 || value === 0)).toBe(true);
  });

  it("returns a same-sized surface", () => {
    const out = glowCpu(flat(7, 4, [10, 200, 30, 255]), { radius: 2, brightness: 0, contrast: 0 });
    expect(out.width).toBe(7);
    expect(out.height).toBe(4);
  });
});

describe("Glow binding", () => {
  it("runs the CPU reference from its parameters", () => {
    const binding = glowBinding();
    const out = binding.cpu(flat(4, 4, [51, 51, 51, 255]), binding.params({ radius: 4 }));
    expect(out.width).toBe(4);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(GLOW_ID);
  });
});
