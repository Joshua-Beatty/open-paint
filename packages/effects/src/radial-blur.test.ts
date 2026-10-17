/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import { documentCenter } from "./distortion";
import { LAYER_UNDERLAY_KEY } from "./framework/binding";
import { builtinEffectBindings } from "./index";
import {
  RADIAL_BLUR_ID,
  radialBlurBinding,
  radialBlurCpu,
  radialBlurDescriptor,
  radialBlurParams,
  radialBlurPlan,
  radialBlurSchema,
} from "./radial-blur";

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

describe("Radial Blur descriptor and schema", () => {
  it("is a configurable Blurs effect", () => {
    expect(radialBlurDescriptor(2)).toMatchObject({
      id: RADIAL_BLUR_ID,
      label: "effect.radialBlur",
      category: "effect",
      submenu: "blurs",
      configurable: true,
      kind: "gpuImage",
    });
  });

  it("lists Angle, Center and Quality, in that order", () => {
    const keys = radialBlurSchema(2).properties.map((property) => property.key);
    expect(keys).toEqual(["angle", "center", "quality"]);
  });

  it("uses the spec's ranges and defaults, with a Center pad over the whole layer", () => {
    const find = (key: string) =>
      radialBlurSchema(2).properties.find((property) => property.key === key);
    expect(find("angle")).toMatchObject({ kind: "double", defaultValue: 4, min: 0, max: 360 });
    expect(find("center")).toMatchObject({
      kind: "vector2",
      defaultValue: { x: 0, y: 0 },
      min: { x: -2, y: -2 },
      max: { x: 2, y: 2 },
      control: { staticImageUnderlay: LAYER_UNDERLAY_KEY },
    });
    expect(find("quality")).toMatchObject({ kind: "double", min: 1, max: 8 });
  });

  it("takes its Quality default from the factory level, with one decimal", () => {
    const quality = (factory: number) =>
      radialBlurSchema(factory).properties.find((property) => property.key === "quality");
    expect(quality(1)).toMatchObject({ defaultValue: 1, control: { decimalPlaces: 1 } });
    expect(quality(2)).toMatchObject({ defaultValue: 2 });
  });

  it("clamps stored values to the schema ranges", () => {
    const clamped = resolveValues(radialBlurSchema(2), {
      angle: 400,
      center: { x: 5, y: -5 },
      quality: 9,
    });
    expect(clamped).toMatchObject({ angle: 360, center: { x: 2, y: -2 }, quality: 8 });
  });
});

describe("Radial Blur parameters, plan and center", () => {
  it("reads the defaults, and the quality keeps its decimal", () => {
    expect(radialBlurParams({}, 2)).toMatchObject({
      angle: 4,
      center: { x: 0, y: 0 },
      quality: 2,
      document: undefined,
      regionOrigin: undefined,
    });
    expect(radialBlurParams({ quality: 1.5 }, 2).quality).toBe(1.5);
  });

  it("has one cos, sin pair per sample, at floor(2^(Quality + 5)) samples", () => {
    const plan = radialBlurPlan({
      angle: 90,
      center: { x: 0, y: 0 },
      quality: 1,
      document: undefined,
      regionOrigin: undefined,
    });
    expect(plan.length).toBe(128);
  });

  it("centers on the document, offset by Center in half-document units", () => {
    expect([...documentCenter({ x: 0, y: 0 }, 40, 24, undefined, undefined)]).toEqual([20, 12]);
    // Document 80x48 with the region at (20, 12): Center (1, 0) moves the center 40 px right.
    const center = documentCenter(
      { x: 1, y: 0 },
      40,
      24,
      { width: 80, height: 48 },
      { x: 20, y: 12 },
    );
    expect(center[0]).toBeCloseTo(60, 5);
    expect(center[1]).toBeCloseTo(12, 5);
  });
});

describe("Radial Blur CPU reference", () => {
  it("returns an unchanged image at angle 0", () => {
    const input = dotImage(9, 7, 3, 4);
    const out = radialBlurCpu(input, {
      angle: 0,
      center: { x: 0, y: 0 },
      quality: 1,
      document: undefined,
      regionOrigin: undefined,
    });
    expect([...out.data]).toEqual([...input.data]);
  });

  it("leaves an opaque uniform image unchanged", () => {
    const data = new Uint8ClampedArray(12 * 9 * 4);
    for (let i = 0; i < 12 * 9; i++) data.set([70, 140, 210, 255], i * 4);
    const uniform = new Surface(12, 9, data);
    const out = radialBlurCpu(uniform, {
      angle: 90,
      center: { x: 0.5, y: -0.5 },
      quality: 1,
      document: undefined,
      regionOrigin: undefined,
    });
    expect([...out.data]).toEqual([...uniform.data]);
  });

  it("keeps a bright pixel lit on its own ring about the center, and leaves far pixels dark", () => {
    const input = dotImage(9, 9, 6, 4);
    const out = radialBlurCpu(input, {
      angle: 90,
      center: { x: 0, y: 0 },
      quality: 1,
      document: undefined,
      regionOrigin: undefined,
    });
    const lit = (x: number, y: number) => out.data[(y * 9 + x) * 4] ?? 0;
    // The bright pixel lies at radius 2 from the center (4.5, 4.5), so the rotations keep it on its ring.
    expect(lit(6, 4)).toBeGreaterThan(0);
    expect(lit(0, 0)).toBe(0);
  });
});

describe("Radial Blur binding", () => {
  it("reads its parameters from values and the region, and runs the CPU reference", () => {
    const binding = radialBlurBinding(1);
    const params = binding.params({ angle: 30 }, { width: 80, height: 48 }, 0, { x: 20, y: 12 });
    expect(params).toMatchObject({
      angle: 30,
      document: { width: 80, height: 48 },
      regionOrigin: { x: 20, y: 12 },
    });
    expect(binding.cpu(dotImage(8, 6, 3, 2), params).height).toBe(6);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(RADIAL_BLUR_ID);
  });
});
