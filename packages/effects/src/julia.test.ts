/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  builtinEffectBindings,
  FRACTAL_PARAMS_BYTES,
  FRACTAL_WGSL,
  JULIA_ID,
  type JuliaParams,
  juliaCpu,
  juliaDescriptor,
  juliaParams,
  juliaSchema,
} from "./index";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const BASE: JuliaParams = {
  factor: 4,
  zoom: 1,
  angle: 0,
  quality: 1,
  mode: 2,
  origin: undefined,
  document: undefined,
};

/** A fully transparent image: Overwrite replaces it with the fractal, so the result is the fractal. */
function blank(width: number, height: number): Surface {
  return new Surface(width, height, new Uint8ClampedArray(width * height * 4));
}

describe("Julia descriptor and schema (FX-RENDER-JULIA-01)", () => {
  it("is a configurable GPU effect in the Render submenu, in linear space", () => {
    expect(juliaDescriptor(1)).toMatchObject({
      id: JULIA_ID,
      label: "effect.julia",
      category: "effect",
      submenu: "render",
      configurable: true,
      kind: "gpuImage",
      options: { gpu: { workingSpace: "linear", inputAlpha: "straight" } },
    });
  });

  it("lists Factor, Zoom, Angle, Quality and Blend Mode in the spec's order and ranges", () => {
    const schema = juliaSchema(2);
    expect(schema.properties.map((property) => property.key)).toEqual([
      "factor",
      "zoom",
      "angle",
      "quality",
      "blendMode",
    ]);
    const find = (key: string) => schema.properties.find((p) => p.key === key);
    expect(find("factor")).toMatchObject({ kind: "double", defaultValue: 4, min: 1, max: 10 });
    expect(find("zoom")).toMatchObject({ kind: "double", defaultValue: 1, min: 0.1, max: 50 });
    expect(find("angle")).toMatchObject({ kind: "double", defaultValue: 0, min: -180, max: 180 });
    expect(find("quality")).toMatchObject({ kind: "int32", defaultValue: 2, min: 1, max: 8 });
    const blend = find("blendMode");
    if (blend?.kind !== "choice") throw new Error("expected the Blend Mode drop-down");
    expect(blend).toMatchObject({ defaultValue: 2 });
    expect(blend.options).toHaveLength(46);
  });

  it("reads the parameters, clamps them to the schema, and keeps the given document and origin", () => {
    const params = juliaParams(
      { factor: 99, zoom: 0, quality: 20 },
      3,
      { width: 64, height: 48 },
      {
        x: 3,
        y: 4,
      },
    );
    expect(params).toMatchObject({
      factor: 10,
      zoom: 0.1,
      angle: 0,
      quality: 8,
      mode: 2,
      document: { width: 64, height: 48 },
      origin: { x: 3, y: 4 },
    });
    expect(resolveValues(juliaSchema(3), {}).quality).toBe(3);
  });

  it("is registered as a built-in effect after Turbulence", () => {
    const bindings = builtinEffectBindings(1);
    expect(bindings.at(-12)?.descriptor.id).toBe(JULIA_ID);
  });
});

describe("Julia Rust reference", () => {
  it("has a shader with the Julia entry point over the shared fractal code", () => {
    expect(FRACTAL_WGSL).toContain("fn julia(");
    expect(FRACTAL_WGSL).toContain("fn julia_color(");
    expect(FRACTAL_WGSL).toContain("fn mix_pixel(");
    expect(FRACTAL_PARAMS_BYTES).toBe(64);
  });

  it("rounds every orbit product before adding it, whatever the shader compiler fuses", () => {
    // A product added straight after (z.x * z.x - ..., 2.0 * z.x * z.y + c) may compile to a fused
    // multiply-add, which differs from Rust in the last bit; Firefox's compiler does fuse it.
    const shader = FRACTAL_WGSL.replace(/\/\/.*$/gm, "");
    expect(shader).not.toMatch(/z\.x \* z\.x/);
    expect(shader).not.toMatch(/\* p\.(cos_angle|sin_angle|aspect|inv_zoom) [-+]/);
    expect(shader).toMatch(/bitcast<vec4<u32>>\(a \* b\) \^ vec4<u32>\(p\.zero\)/);
  });

  it("is deterministic and produces a fractal that is not the blank input", () => {
    const first = juliaCpu(blank(32, 24), BASE);
    const again = juliaCpu(blank(32, 24), BASE);
    expect(first.data).toEqual(again.data);
    expect(first.data).not.toEqual(blank(32, 24).data);
  });

  it("gives the same pixels for a region as for the same place in the whole document", () => {
    const document = { width: 32, height: 24 };
    const whole = juliaCpu(blank(32, 24), { ...BASE, document, origin: { x: 0, y: 0 } });
    const region = juliaCpu(blank(4, 3), { ...BASE, document, origin: { x: 5, y: 7 } });
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

  it("composites with the blend mode: Over on an opaque layer keeps it opaque", () => {
    const data = new Uint8ClampedArray(64);
    for (let i = 0; i < data.length; i++) data[i] = i % 4 === 3 ? 255 : 200;
    const out = juliaCpu(new Surface(4, 4, data), { ...BASE, mode: 0 });
    for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(255);
  });
});
