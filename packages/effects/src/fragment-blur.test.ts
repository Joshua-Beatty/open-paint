/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  builtinEffectBindings,
  FRAGMENT_BLUR_ID,
  fragmentBlurBinding,
  fragmentBlurCpu,
  fragmentBlurDescriptor,
  fragmentBlurOffsets,
  fragmentBlurParams,
  fragmentBlurSchema,
} from "./index";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

/** An opaque black image with one white pixel. */
function dotImage(width: number, height: number, x: number, y: number): Surface {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([0, 0, 0, 255], i * 4);
  data.set([255, 255, 255, 255], (y * width + x) * 4);
  return new Surface(width, height, data);
}

describe("Fragment Blur descriptor and schema", () => {
  it("is a configurable Blurs effect", () => {
    expect(fragmentBlurDescriptor()).toMatchObject({
      id: FRAGMENT_BLUR_ID,
      label: "effect.fragmentBlur",
      category: "effect",
      submenu: "blurs",
      configurable: true,
      kind: "gpuImage",
    });
  });

  it("lists Fragment Count, Distance and Rotation, in that order", () => {
    const keys = fragmentBlurSchema().properties.map((property) => property.key);
    expect(keys).toEqual(["count", "distance", "rotation"]);
  });

  it("uses the spec's ranges and defaults", () => {
    const find = (key: string) =>
      fragmentBlurSchema().properties.find((property) => property.key === key);
    expect(find("count")).toMatchObject({ kind: "int32", defaultValue: 4, min: 2, max: 200 });
    expect(find("distance")).toMatchObject({ kind: "int32", defaultValue: 8, min: 0, max: 400 });
    expect(find("rotation")).toMatchObject({ kind: "double", defaultValue: 0, min: 0, max: 360 });
  });

  it("clamps stored values to the schema ranges", () => {
    const clamped = resolveValues(fragmentBlurSchema(), {
      count: 500,
      distance: -4,
      rotation: 400,
    });
    expect(clamped).toMatchObject({ count: 200, distance: 0, rotation: 360 });
  });
});

describe("Fragment Blur parameters and offsets", () => {
  it("reads the defaults and rounds the integer controls", () => {
    expect(fragmentBlurParams({})).toEqual({ count: 4, distance: 8, rotation: 0 });
    expect(fragmentBlurParams({ count: 5.4, distance: 12 })).toMatchObject({
      count: 5,
      distance: 12,
    });
  });

  it("places n copies on a circle of the given distance", () => {
    const offsets = fragmentBlurOffsets({ count: 4, distance: 3, rotation: 0 });
    expect(offsets.length).toBe(8);
    const expected = [-3, 0, 0, 3, 3, 0, 0, -3];
    for (const [i, value] of expected.entries()) expect(offsets[i]).toBeCloseTo(value, 5);
  });
});

describe("Fragment Blur CPU reference", () => {
  it("leaves an opaque uniform image unchanged, including near the edges", () => {
    const data = new Uint8ClampedArray(12 * 9 * 4);
    for (let i = 0; i < 12 * 9; i++) data.set([70, 140, 210, 255], i * 4);
    const uniform = new Surface(12, 9, data);
    const out = fragmentBlurCpu(uniform, { count: 8, distance: 1.5, rotation: 15 });
    expect(out.width).toBe(12);
    expect([...out.data]).toEqual([...uniform.data]);
  });

  it("copies a bright pixel out to the fragment positions", () => {
    const input = dotImage(9, 9, 4, 4);
    const out = fragmentBlurCpu(input, { count: 4, distance: 2, rotation: 0 });
    const lit = (x: number, y: number) => out.data[(y * 9 + x) * 4];
    // Rotation 0 puts the copies left, up, right and down of the pixel.
    expect(lit(2, 4)).toBeGreaterThan(0);
    expect(lit(4, 6)).toBeGreaterThan(0);
    expect(lit(6, 4)).toBeGreaterThan(0);
    expect(lit(4, 2)).toBeGreaterThan(0);
    expect(lit(0, 0)).toBe(0);
  });

  it("returns the input unchanged at distance 0 when it is opaque", () => {
    const input = dotImage(5, 5, 2, 3);
    const out = fragmentBlurCpu(input, { count: 7, distance: 0, rotation: 45 });
    expect([...out.data]).toEqual([...input.data]);
  });
});

describe("Fragment Blur binding", () => {
  it("reads its parameters and runs the CPU reference", () => {
    const binding = fragmentBlurBinding();
    const params = binding.params({ count: 3 });
    expect(params).toMatchObject({ count: 3, distance: 8 });
    expect(binding.cpu(dotImage(8, 6, 3, 2), params).height).toBe(6);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(FRAGMENT_BLUR_ID);
  });
});
