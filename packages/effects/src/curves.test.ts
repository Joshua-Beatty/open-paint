/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { beforeAll, describe, expect, it } from "vitest";
import { identityPlan } from "./adjustments";
import {
  CURVE_IDENTITY,
  CURVES_LUMINOSITY_OP,
  CURVES_RGB_OP,
  type CurveList,
  type CurvesParams,
  curveLut,
  curvesBinding,
  curvesCpu,
  curvesDescriptor,
  curvesParams,
  curvesPlan,
  curvesSchema,
  curvesTables,
  curvesValues,
  curveValueAt,
  decodeCurve,
  encodeCurve,
} from "./curves";
import { builtinEffectBindings } from "./index";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

/** Gray pixels with alpha 255, one per value. */
function gray(values: readonly number[]): Surface {
  const data = new Uint8ClampedArray(values.length * 4);
  values.forEach((value, i) => {
    data.set([value, value, value, 255], i * 4);
  });
  return new Surface(values.length, 1, data);
}

const INVERT: CurveList = [
  [0, 255],
  [255, 0],
];

function params(overrides: Partial<CurvesParams> = {}): CurvesParams {
  return {
    mode: "luminosity",
    luminosity: CURVE_IDENTITY,
    red: CURVE_IDENTITY,
    green: CURVE_IDENTITY,
    blue: CURVE_IDENTITY,
    ...overrides,
  };
}

describe("Curves descriptor and schema (ADJ-CURVES-UI-02, ADJ-MENU-03)", () => {
  it("is a configurable adjustment with the custom dialog token", () => {
    expect(curvesDescriptor()).toMatchObject({
      id: "curves",
      category: "adjustment",
      configurable: true,
      kind: "gpuImage",
      label: "effect.curves",
      customDialog: "curves",
    });
  });

  it("is registered after Levels with the other built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids.at(-47)).toBe("curves");
  });

  it("stores the mode with Luminosity as the default, and one point list per curve", () => {
    const schema = curvesSchema();
    expect(schema.properties.map((property) => property.key)).toEqual([
      "mode",
      "luminosity",
      "red",
      "green",
      "blue",
    ]);
    expect(schema.properties[0]).toMatchObject({ kind: "choice", defaultValue: "luminosity" });
  });
});

describe("stored curves (ADJ-CURVES-UI-12, ADJ-COMMON-07)", () => {
  it("round-trips a list through its text form", () => {
    const list: CurveList = [
      [0, 0],
      [64, 90],
      [255, 255],
    ];
    expect(decodeCurve(encodeCurve(list))).toEqual(list);
    expect(encodeCurve(CURVE_IDENTITY)).toBe("0,0 255,255");
  });

  it("sorts points by x", () => {
    expect(decodeCurve("200,10 0,0 255,255")).toEqual([
      [0, 0],
      [200, 10],
      [255, 255],
    ]);
  });

  it("falls back to the identity for any malformed list", () => {
    for (const text of ["", "   ", "0,0 300,5", "0,0 10", "1,1 1,2", "a,b", "0,0 -1,4"]) {
      expect(decodeCurve(text)).toEqual(CURVE_IDENTITY);
    }
  });

  it("reads the parameters with the mode clamped to the choices", () => {
    expect(curvesParams({ mode: "rgb", red: "0,255 255,0" })).toMatchObject({
      mode: "rgb",
      red: [
        [0, 255],
        [255, 0],
      ],
      green: CURVE_IDENTITY,
    });
    expect(curvesParams({ mode: "sideways" }).mode).toBe("luminosity");
    expect(curvesParams({ luminosity: 42 }).luminosity).toEqual(CURVE_IDENTITY);
  });

  it("stores only the active mode's curves", () => {
    const luminosity = curvesValues(
      params({ mode: "luminosity", luminosity: INVERT, red: INVERT }),
    );
    expect(luminosity).toEqual({
      mode: "luminosity",
      luminosity: "0,255 255,0",
      red: "0,0 255,255",
      green: "0,0 255,255",
      blue: "0,0 255,255",
    });
    const rgb = curvesValues(params({ mode: "rgb", luminosity: INVERT, red: INVERT }));
    expect(rgb).toMatchObject({ mode: "rgb", luminosity: "0,0 255,255", red: "0,255 255,0" });
  });
});

describe("Curves math (ADJ-CURVES-MATH-01..04)", () => {
  it("builds a 1024-entry table that is the identity for the identity curve", () => {
    const lut = curveLut(CURVE_IDENTITY);
    expect(lut).toHaveLength(1024);
    expect(curveValueAt(lut, 0.5)).toBeCloseTo(0.5, 5);
  });

  it("samples a table with the same interpolation as the kernel", () => {
    const ramp = Float32Array.from({ length: 1024 }, (_, k) => k / 1023);
    expect(curveValueAt(ramp, 0)).toBe(0);
    expect(curveValueAt(ramp, 1)).toBe(1);
    expect(curveValueAt(ramp, 0.25)).toBeCloseTo(0.25, 6);
    expect(curveValueAt(ramp, 2)).toBe(1);
  });

  it("puts the luminosity table in block 0 and the RGB tables after it", () => {
    const tables = curvesTables(params({ red: INVERT }));
    expect(tables).toHaveLength(4 * 1024);
    expect(tables[1024 + 1023]).toBeCloseTo(0, 6);
    expect(tables[2048 + 1023]).toBeCloseTo(1, 6);
  });

  it("uses the Luminosity or the RGB op for its mode", () => {
    expect(curvesPlan(params()).op).toBe(CURVES_LUMINOSITY_OP);
    expect(curvesPlan(params({ mode: "rgb" })).op).toBe(CURVES_RGB_OP);
    expect(curvesPlan(params()).curves).toHaveLength(4 * 1024);
    expect(identityPlan(3).curves).toHaveLength(4 * 1024);
  });

  it("leaves the image unchanged for the identity curves in either mode", () => {
    const input = gray([0, 37, 128, 255]);
    expect(curvesCpu(input, params()).data).toEqual(input.data);
    expect(curvesCpu(input, params({ mode: "rgb" })).data).toEqual(input.data);
  });

  it("inverts gray in Luminosity mode", () => {
    const out = curvesCpu(gray([0, 64, 200, 255]), params({ luminosity: INVERT })).data;
    const values = [0, 1, 2, 3].map((index) => out[index * 4] ?? 0);
    expect(values[0]).toBe(255);
    expect(values[1]).toBeCloseTo(191, 0);
    expect(values[2]).toBeCloseTo(55, 0);
    expect(values[3]).toBe(0);
  });

  it("applies each RGB table to its own channel and keeps alpha", () => {
    const input = new Surface(1, 1, new Uint8ClampedArray([10, 100, 200, 77]));
    const out = curvesCpu(input, params({ mode: "rgb", red: INVERT }));
    expect([...out.data]).toEqual([245, 100, 200, 77]);
  });

  it("keeps the alpha of transparent pixels in Luminosity mode", () => {
    const input = new Surface(1, 1, new Uint8ClampedArray([200, 100, 50, 0]));
    const out = curvesCpu(input, params({ luminosity: INVERT }));
    expect(out.data[3]).toBe(0);
  });

  it("binds the descriptor, the parameter reader and the CPU reference", () => {
    const binding = curvesBinding();
    expect(binding.descriptor.id).toBe("curves");
    expect(binding.params({ mode: "rgb" })).toMatchObject({ mode: "rgb" });
    const input = gray([90]);
    expect([...binding.cpu(input, params()).data]).toEqual([...input.data]);
  });
});
