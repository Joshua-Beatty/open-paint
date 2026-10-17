/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import { LAYER_UNDERLAY_KEY } from "./framework/binding";
import { builtinEffectBindings } from "./index";
import {
  ZOOM_BLUR_ID,
  zoomBlurBinding,
  zoomBlurCpu,
  zoomBlurDescriptor,
  zoomBlurParams,
  zoomBlurPlan,
  zoomBlurSchema,
} from "./zoom-blur";

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

describe("Zoom Blur descriptor and schema", () => {
  it("is a configurable Blurs effect", () => {
    expect(zoomBlurDescriptor(2)).toMatchObject({
      id: ZOOM_BLUR_ID,
      label: "effect.zoomBlur",
      category: "effect",
      submenu: "blurs",
      configurable: true,
      kind: "gpuImage",
    });
  });

  it("lists Distance, Focus, Center and Quality, in that order", () => {
    const keys = zoomBlurSchema(2).properties.map((property) => property.key);
    expect(keys).toEqual(["distance", "focus", "center", "quality"]);
  });

  it("uses the spec's ranges and defaults, with a Center pad over the whole layer", () => {
    const find = (key: string) =>
      zoomBlurSchema(2).properties.find((property) => property.key === key);
    expect(find("distance")).toMatchObject({
      kind: "double",
      defaultValue: 1.25,
      min: 0.25,
      max: 4,
    });
    expect(find("focus")).toMatchObject({ kind: "double", defaultValue: 2, min: 1, max: 4 });
    expect(find("center")).toMatchObject({
      kind: "vector2",
      defaultValue: { x: 0, y: 0 },
      min: { x: -2, y: -2 },
      max: { x: 2, y: 2 },
      control: { staticImageUnderlay: LAYER_UNDERLAY_KEY },
    });
  });

  it("takes its Quality default from the factory level, with one decimal", () => {
    const quality = (factory: number) =>
      zoomBlurSchema(factory).properties.find((property) => property.key === "quality");
    expect(quality(1)).toMatchObject({ defaultValue: 1, control: { decimalPlaces: 1 } });
    expect(quality(2)).toMatchObject({ defaultValue: 2 });
  });

  it("clamps stored values to the schema ranges", () => {
    const clamped = resolveValues(zoomBlurSchema(2), {
      distance: 9,
      focus: 0,
      center: { x: -3, y: 0 },
      quality: 0,
    });
    expect(clamped).toMatchObject({ distance: 4, focus: 1, center: { x: -2, y: 0 }, quality: 1 });
  });
});

describe("Zoom Blur parameters and plan", () => {
  it("reads the defaults", () => {
    expect(zoomBlurParams({}, 1)).toMatchObject({
      distance: 1.25,
      focus: 2,
      center: { x: 0, y: 0 },
      quality: 1,
    });
  });

  it("has one scale and weight per sample, and the weights sum to 1", () => {
    const plan = zoomBlurPlan({
      distance: 1.25,
      focus: 2,
      center: { x: 0, y: 0 },
      quality: 1,
      document: undefined,
      regionOrigin: undefined,
    });
    expect(plan.length).toBe(128);
    let total = 0;
    for (let i = 1; i < plan.length; i += 2) total += plan[i] ?? 0;
    expect(total).toBeCloseTo(1, 5);
  });

  it("has no scales at distance 1", () => {
    const plan = zoomBlurPlan({
      distance: 1,
      focus: 2,
      center: { x: 0, y: 0 },
      quality: 1,
      document: undefined,
      regionOrigin: undefined,
    });
    expect(plan.length).toBe(0);
  });
});

describe("Zoom Blur CPU reference", () => {
  it("passes the image through at distance 1", () => {
    const input = dotImage(9, 7, 2, 3);
    const out = zoomBlurCpu(input, {
      distance: 1,
      focus: 2,
      center: { x: 0, y: 0 },
      quality: 1,
      document: undefined,
      regionOrigin: undefined,
    });
    expect([...out.data]).toEqual([...input.data]);
  });

  it("leaves an opaque uniform image unchanged", () => {
    const data = new Uint8ClampedArray(10 * 8 * 4);
    for (let i = 0; i < 10 * 8; i++) data.set([200, 30, 90, 255], i * 4);
    const uniform = new Surface(10, 8, data);
    const out = zoomBlurCpu(uniform, {
      distance: 3,
      focus: 1,
      center: { x: 0.25, y: 0.5 },
      quality: 1,
      document: undefined,
      regionOrigin: undefined,
    });
    expect([...out.data]).toEqual([...uniform.data]);
  });

  it("smears a bright pixel outward from the center", () => {
    const input = dotImage(9, 9, 6, 4);
    const out = zoomBlurCpu(input, {
      distance: 2,
      focus: 1,
      center: { x: 0, y: 0 },
      quality: 1,
      document: undefined,
      regionOrigin: undefined,
    });
    const lit = (x: number) => out.data[(4 * 9 + x) * 4] ?? 0;
    expect(lit(7)).toBeGreaterThan(0);
    expect(lit(5)).toBe(0);
  });
});

describe("Zoom Blur binding", () => {
  it("reads its parameters from values and the region, and runs the CPU reference", () => {
    const binding = zoomBlurBinding(1);
    const params = binding.params({ focus: 3 }, { width: 80, height: 48 }, 0, { x: 20, y: 12 });
    expect(params).toMatchObject({
      focus: 3,
      document: { width: 80, height: 48 },
      regionOrigin: { x: 20, y: 12 },
    });
    expect(binding.cpu(dotImage(8, 6, 3, 2), params).height).toBe(6);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(ZOOM_BLUR_ID);
  });
});
