/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  builtinEffectBindings,
  OUTLINE_ID,
  outlineBinding,
  outlineCpu,
  outlineDescriptor,
  outlineParams,
  outlineSchema,
  planOutline,
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

describe("Outline descriptor and schema", () => {
  it("is a configurable Stylize effect in document space", () => {
    expect(outlineDescriptor()).toMatchObject({
      id: OUTLINE_ID,
      label: "effect.outline",
      category: "effect",
      submenu: "stylize",
      configurable: true,
      kind: "gpuImage",
      options: { gpu: { workingSpace: "document", inputAlpha: "straight" } },
    });
  });

  it("lists Thickness, Intensity and Quality with the spec's defaults and ranges", () => {
    const properties = outlineSchema().properties;
    expect(properties.map((property) => property.key)).toEqual([
      "thickness",
      "intensity",
      "quality",
    ]);
    expect(properties[0]).toMatchObject({ kind: "int32", defaultValue: 3, min: 1, max: 50 });
    expect(properties[1]).toMatchObject({ kind: "int32", defaultValue: 50, min: 0, max: 100 });
    expect(properties[2]).toMatchObject({ kind: "int32", defaultValue: 8, min: 1, max: 12 });
  });

  it("clamps stored values to the schema", () => {
    expect(resolveValues(outlineSchema(), {})).toMatchObject({
      thickness: 3,
      intensity: 50,
      quality: 8,
    });
    expect(outlineParams({ thickness: 99, intensity: -4, quality: 40 })).toEqual({
      thickness: 50,
      intensity: 0,
      quality: 12,
    });
  });
});

describe("Outline plan and CPU reference", () => {
  it("uses the ranks (100 - I) and (100 + I) in half-percent units", () => {
    expect(planOutline({ thickness: 3, intensity: 50, quality: 8 })).toEqual({
      lowRank: 50,
      highRank: 150,
    });
    expect(planOutline({ thickness: 3, intensity: 100, quality: 8 })).toEqual({
      lowRank: 0,
      highRank: 200,
    });
  });

  it("leaves a flat image white, keeping its alpha", () => {
    const out = outlineCpu(flat(4, 3, [90, 40, 200, 77]), {
      thickness: 2,
      intensity: 50,
      quality: 8,
    });
    expect(out.width).toBe(4);
    expect(out.height).toBe(3);
    for (let i = 0; i < out.data.length; i += 4) {
      expect([...out.data.slice(i, i + 4)]).toEqual([255, 255, 255, 77]);
    }
  });

  it("draws a dark line on a step and keeps the flat sides white", () => {
    const step = new Surface(
      4,
      1,
      new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255]),
    );
    const out = outlineCpu(step, { thickness: 1, intensity: 100, quality: 8 });
    expect(out.data[0]).toBe(255);
    expect(out.data[1 * 4]).toBe(0);
    expect(out.data[2 * 4]).toBe(0);
    expect(out.data[3 * 4]).toBe(255);
  });

  it("is white at Intensity 0, where both ranks are the median", () => {
    const step = new Surface(
      4,
      1,
      new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255]),
    );
    const out = outlineCpu(step, { thickness: 2, intensity: 0, quality: 8 });
    expect([...out.data].filter((_, i) => i % 4 !== 3).every((value) => value === 255)).toBe(true);
  });
});

describe("Outline binding", () => {
  it("runs the CPU reference from its parameters", () => {
    const binding = outlineBinding();
    const out = binding.cpu(flat(4, 4, [51, 51, 51, 255]), binding.params({ thickness: 2 }));
    expect(out.width).toBe(4);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(OUTLINE_ID);
  });
});
