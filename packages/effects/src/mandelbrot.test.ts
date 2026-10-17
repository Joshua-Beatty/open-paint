/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { beforeAll, describe, expect, it } from "vitest";
import {
  builtinEffectBindings,
  MANDELBROT_ID,
  type MandelbrotParams,
  mandelbrotCpu,
  mandelbrotDescriptor,
  mandelbrotParams,
  mandelbrotPlan,
  mandelbrotSchema,
} from "./index";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const BASE: MandelbrotParams = {
  factor: 1,
  zoom: 1,
  angle: 0,
  quality: 1,
  mode: 2,
  invert: false,
  origin: undefined,
  document: undefined,
};

/** A fully transparent image: Overwrite replaces it with the fractal, so the result is the fractal. */
function blank(width: number, height: number): Surface {
  return new Surface(width, height, new Uint8ClampedArray(width * height * 4));
}

describe("Mandelbrot descriptor and schema (FX-RENDER-MANDEL-01)", () => {
  it("is a configurable GPU effect in the Render submenu, in linear space", () => {
    expect(mandelbrotDescriptor(1)).toMatchObject({
      id: MANDELBROT_ID,
      label: "effect.mandelbrot",
      category: "effect",
      submenu: "render",
      configurable: true,
      kind: "gpuImage",
      options: { gpu: { workingSpace: "linear", inputAlpha: "straight" } },
    });
  });

  it("lists Factor, Zoom, Angle, Quality, Invert Colors and Blend Mode in the spec's order", () => {
    const schema = mandelbrotSchema(1);
    expect(schema.properties.map((property) => property.key)).toEqual([
      "factor",
      "zoom",
      "angle",
      "quality",
      "invert",
      "blendMode",
    ]);
    const find = (key: string) => schema.properties.find((p) => p.key === key);
    expect(find("factor")).toMatchObject({ kind: "double", defaultValue: 1, min: 1, max: 10 });
    expect(find("zoom")).toMatchObject({ kind: "double", defaultValue: 10, min: 0, max: 100 });
    expect(find("invert")).toMatchObject({ kind: "boolean", defaultValue: false });
    const blend = find("blendMode");
    if (blend?.kind !== "choice") throw new Error("expected the Blend Mode drop-down");
    expect(blend).toMatchObject({ defaultValue: 2 });
  });

  it("reads Invert Colors and clamps the rest, keeping the given origin", () => {
    const params = mandelbrotParams({ invert: true, zoom: 500 }, 2, undefined, { x: 1, y: 2 });
    expect(params).toMatchObject({
      invert: true,
      zoom: 100,
      quality: 2,
      mode: 2,
      origin: { x: 1, y: 2 },
    });
    expect(mandelbrotParams({}, 2).invert).toBe(false);
  });

  it("is registered as a built-in effect after Julia", () => {
    const bindings = builtinEffectBindings(1);
    expect(bindings.at(-11)?.descriptor.id).toBe(MANDELBROT_ID);
  });
});

describe("Mandelbrot Rust reference", () => {
  it("appends the invert flag to the Julia plan layout", () => {
    const input = blank(8, 6);
    const plan = mandelbrotPlan(
      { ...BASE, invert: true, document: { width: 8, height: 6 } },
      input,
    );
    expect(plan).toHaveLength(13);
    expect(plan[12]).toBe(1);
    expect(mandelbrotPlan(BASE, input)[12]).toBe(0);
  });

  it("is deterministic and produces a fractal that is not the blank input", () => {
    const first = mandelbrotCpu(blank(32, 24), BASE);
    const again = mandelbrotCpu(blank(32, 24), BASE);
    expect(first.data).toEqual(again.data);
    expect(first.data).not.toEqual(blank(32, 24).data);
  });

  it("inverts the RGB of the fractal and leaves its alpha", () => {
    const plain = mandelbrotCpu(blank(32, 24), BASE);
    const inverted = mandelbrotCpu(blank(32, 24), { ...BASE, invert: true });
    expect(inverted.data).not.toEqual(plain.data);
    for (let i = 0; i < plain.data.length; i += 4) {
      expect(inverted.data[i + 3]).toBe(plain.data[i + 3]);
    }
  });

  it("gives the same pixels for a region as for the same place in the whole document", () => {
    const document = { width: 32, height: 24 };
    const whole = mandelbrotCpu(blank(32, 24), { ...BASE, document, origin: { x: 0, y: 0 } });
    const region = mandelbrotCpu(blank(4, 3), { ...BASE, document, origin: { x: 5, y: 7 } });
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
});
