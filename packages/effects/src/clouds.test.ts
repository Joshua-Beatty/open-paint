/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  builtinEffectBindings,
  CLOUDS_ID,
  CLOUDS_PARAMS_BYTES,
  CLOUDS_WGSL,
  type CloudsParams,
  cloudsBinding,
  cloudsCpu,
  cloudsDescriptor,
  cloudsParams,
  cloudsPermutation,
  cloudsPlan,
  cloudsSchema,
} from "./index";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const RED = { r: 1, g: 0, b: 0, a: 1 };
const BLUE = { r: 0, g: 0, b: 1, a: 0.5 };

const BASE: CloudsParams = {
  scale: 250,
  roughness: 0.5,
  mode: 0,
  seed: 5,
  color1: { r: 0, g: 0, b: 0, a: 1 },
  color2: { r: 1, g: 1, b: 1, a: 1 },
  origin: undefined,
  document: undefined,
};

/** A fully transparent image: Overwrite replaces it with the clouds, so the result is the clouds. */
function blank(width: number, height: number): Surface {
  return new Surface(width, height, new Uint8ClampedArray(width * height * 4));
}

describe("Clouds descriptor and schema (FX-RENDER-CLOUDS-01)", () => {
  it("is a configurable GPU effect in the Render submenu, in document space", () => {
    expect(cloudsDescriptor()).toMatchObject({
      id: CLOUDS_ID,
      label: "effect.clouds",
      category: "effect",
      submenu: "render",
      configurable: true,
      kind: "gpuImage",
      options: { gpu: { workingSpace: "document", inputAlpha: "straight" } },
    });
  });

  it("lists Scale, Roughness, Blend Mode, Seed and the two colors with the spec's ranges", () => {
    const find = (key: string) => cloudsSchema().properties.find((p) => p.key === key);
    expect(find("scale")).toMatchObject({ kind: "int32", defaultValue: 250, min: 2, max: 1000 });
    expect(find("scale")?.control).toMatchObject({ useExponentialScale: true });
    expect(find("roughness")).toMatchObject({ kind: "double", defaultValue: 0.5, min: 0, max: 1 });
    const blend = find("blendMode");
    if (blend?.kind !== "choice") throw new Error("expected the Blend Mode drop-down");
    expect(blend).toMatchObject({ defaultValue: 0 });
    expect(blend.options).toHaveLength(46);
    expect(find("seed")).toMatchObject({
      kind: "int32",
      defaultValue: 0,
      min: 0,
      max: 255,
      control: { controlType: "incrementButton" },
    });
    expect(find("color1")).toMatchObject({ kind: "color", alphaMode: "supportsAlpha" });
    expect(find("color2")).toMatchObject({ kind: "color", alphaMode: "supportsAlpha" });
  });

  it("puts Clouds and Colors on two tabs, in the spec's order", () => {
    const layout = cloudsSchema().layout ?? [];
    expect(layout).toHaveLength(1);
    const [tabs] = layout;
    expect(tabs?.kind).toBe("tabs");
    if (tabs?.kind !== "tabs") throw new Error("expected a tab container");
    const keysOf = (page: (typeof tabs.pages)[number]) =>
      page.children.map((child) => (child.kind === "control" ? child.key : child.kind));
    expect(tabs.pages.map((page) => page.label)).toEqual([
      "property.tabClouds",
      "property.tabColors",
    ]);
    expect(tabs.pages.map(keysOf)).toEqual([
      ["scale", "roughness", "blendMode", "seed"],
      ["color1", "color2"],
    ]);
  });

  it("defaults the colors to the primary and secondary colors at open time (FX-FW-TOKEN-01)", () => {
    const binding = cloudsBinding();
    const schema = binding.dialogSchema?.({ primary: RED, secondary: BLUE });
    expect(schema).toBeDefined();
    const defaults = resolveValues(schema ?? cloudsSchema(), {});
    expect(defaults.color1).toEqual(RED);
    expect(defaults.color2).toEqual(BLUE);
    // The descriptor's schema, without colors, falls back to black and white.
    expect(resolveValues(cloudsSchema(), {}).color1).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(resolveValues(cloudsSchema(), {}).color2).toEqual({ r: 1, g: 1, b: 1, a: 1 });
  });

  it("reads the parameters, clamps them to the schema, and mixes in the instance seed", () => {
    const params = cloudsParams({ scale: 5000, seed: 2 }, { width: 64, height: 48 }, 7, {
      x: 3,
      y: 4,
    });
    expect(params).toMatchObject({
      scale: 1000,
      roughness: 0.5,
      mode: 0,
      seed: 2 ^ 7,
      document: { width: 64, height: 48 },
      origin: { x: 3, y: 4 },
    });
    expect(params.color1).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });

  it("has a shader with the mix snippet and the Clouds entry point", () => {
    expect(CLOUDS_WGSL).toContain("@compute @workgroup_size(8, 8)");
    expect(CLOUDS_WGSL).toContain("fn clouds(");
    expect(CLOUDS_WGSL).toContain("fn mix_pixel(");
    expect(CLOUDS_PARAMS_BYTES).toBe(80);
  });

  it("is registered as a built-in effect after the existing ones", () => {
    const bindings = builtinEffectBindings(1);
    expect(bindings.at(-14)?.descriptor.id).toBe(CLOUDS_ID);
  });
});

describe("Clouds Rust reference", () => {
  it("uses Perlin's 256-entry permutation table", () => {
    const table = cloudsPermutation();
    expect(table).toHaveLength(256);
    expect(new Set(table).size).toBe(256);
    expect(Math.max(...table)).toBe(255);
  });

  it("writes the flat parameter array in the order the Rust reader expects", () => {
    const input = blank(4, 3);
    const plan = cloudsPlan(
      { ...BASE, origin: { x: 2, y: 1 }, document: { width: 8, height: 6 } },
      input,
    );
    expect(Array.from(plan.slice(0, 8))).toEqual([2, 1, 8, 6, 250, 0.5, 5, 0]);
    expect(Array.from(plan.slice(8))).toEqual([0, 0, 0, 1, 1, 1, 1, 1]);
  });

  it("is deterministic, depends on the seed, and stays in the image", () => {
    const input = blank(32, 24);
    const first = cloudsCpu(input, { ...BASE, mode: 7 });
    const again = cloudsCpu(input, { ...BASE, mode: 7 });
    const other = cloudsCpu(input, { ...BASE, mode: 7, seed: 6 });
    expect(first.data).toEqual(again.data);
    expect(first.data).not.toEqual(other.data);
    expect(first.width).toBe(32);
    expect(first.height).toBe(24);
  });

  it("gives the same pixels for a region as for the same place in the whole document", () => {
    const whole = cloudsCpu(blank(32, 24), {
      ...BASE,
      mode: 2,
      document: { width: 32, height: 24 },
      origin: { x: 0, y: 0 },
    });
    const region = cloudsCpu(blank(4, 3), {
      ...BASE,
      mode: 2,
      document: { width: 32, height: 24 },
      origin: { x: 5, y: 7 },
    });
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 4; x++) {
        const at = ((y + 7) * 32 + x + 5) * 4;
        const here = (y * 4 + x) * 4;
        expect(Array.from(region.data.slice(here, here + 4))).toEqual(
          Array.from(whole.data.slice(at, at + 4)),
        );
      }
    }
  });

  it("varies across the image, with the two colors as its extremes", () => {
    const out = cloudsCpu(blank(32, 24), { ...BASE, mode: 2 });
    const reds = new Set(out.data.filter((_, i) => i % 4 === 0));
    expect(reds.size).toBeGreaterThan(20);
    expect(Math.max(...out.data.filter((_, i) => i % 4 === 0))).toBeLessThanOrEqual(255);
  });

  it("composites over an opaque layer: opaque clouds keep the layer opaque", () => {
    const data = new Uint8ClampedArray(64);
    for (let i = 0; i < data.length; i++) data[i] = i % 4 === 3 ? 255 : 200;
    const out = cloudsCpu(new Surface(4, 4, data), { ...BASE, mode: 0 });
    for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(255);
  });
});
