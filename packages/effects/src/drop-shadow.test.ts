/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  builtinEffectBindings,
  DROP_SHADOW_ID,
  type DropShadowParams,
  dropShadowBinding,
  dropShadowCpu,
  dropShadowDescriptor,
  dropShadowParams,
  dropShadowSchema,
  planDropShadow,
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

const DEFAULTS: DropShadowParams = {
  radius: 10,
  distance: 10,
  angle: -45,
  opacity: 0.75,
  color: 0,
  onlyShadow: false,
};

describe("Drop Shadow descriptor and schema", () => {
  it("is a configurable Object effect that works in linear light", () => {
    expect(dropShadowDescriptor()).toMatchObject({
      id: DROP_SHADOW_ID,
      label: "effect.dropShadow",
      category: "effect",
      submenu: "object",
      configurable: true,
      kind: "gpuImage",
      options: { gpu: { workingSpace: "linear", inputAlpha: "straight" } },
    });
  });

  it("lists the six controls in the spec's order, with its defaults and ranges", () => {
    const properties = dropShadowSchema().properties;
    expect(properties.map((property) => property.key)).toEqual([
      "radius",
      "distance",
      "angle",
      "opacity",
      "color",
      "onlyShadow",
    ]);
    expect(properties[0]).toMatchObject({
      kind: "double",
      defaultValue: 10,
      min: 0,
      max: 100,
      control: { useExponentialScale: true },
    });
    expect(properties[1]).toMatchObject({ defaultValue: 10, min: 0, max: 100 });
    expect(properties[2]).toMatchObject({
      defaultValue: -45,
      min: -180,
      max: 180,
      control: { controlType: "anglePicker" },
    });
    expect(properties[3]).toMatchObject({ defaultValue: 0.75, min: 0, max: 1 });
    expect(properties[4]).toMatchObject({
      kind: "int32",
      defaultValue: 0,
      min: 0,
      max: 0xff_ff_ff,
      control: { controlType: "colorWheel" },
    });
    expect(properties[5]).toMatchObject({
      kind: "boolean",
      defaultValue: false,
      control: { description: "property.onlyDrawShadow", footnote: "property.dropShadowNote" },
    });
  });

  it("reads the defaults and clamps out-of-range values", () => {
    expect(resolveValues(dropShadowSchema(), {})).toMatchObject({
      radius: 10,
      angle: -45,
      opacity: 0.75,
      onlyShadow: false,
    });
    expect(
      dropShadowParams({
        radius: 500,
        distance: -3,
        angle: 400,
        opacity: 2,
        color: 0x12_34_56,
        onlyShadow: true,
      }),
    ).toEqual({
      radius: 100,
      distance: 0,
      angle: 180,
      opacity: 1,
      color: 0x12_34_56,
      onlyShadow: true,
    });
  });
});

describe("Drop Shadow plan", () => {
  it("returns the blur kernel of σ = radius / 3 and the offset, color and opacity", () => {
    const plan = planDropShadow(DEFAULTS);
    expect(plan.weights.length).toBe(2 * Math.ceil(3 * (10 / 3)) + 1);
    const step = 10 / Math.SQRT2;
    expect(plan.plan[0]).toBeCloseTo(step, 5);
    expect(plan.plan[1]).toBeCloseTo(step, 5);
    expect([...plan.plan.slice(2, 5)]).toEqual([0, 0, 0]);
    expect(plan.plan[5]).toBeCloseTo(0.75, 6);
    expect(plan.onlyShadow).toBe(false);
  });

  it("uses a single unblurred tap at radius 0", () => {
    expect([...planDropShadow({ ...DEFAULTS, radius: 0 }).weights]).toEqual([1]);
  });
});

describe("Drop Shadow CPU reference", () => {
  it("keeps an opaque object's colors where it covers its own shadow", () => {
    const input = flat(6, 6, [200, 100, 50, 255]);
    const out = dropShadowCpu(input, { ...DEFAULTS, distance: 0, radius: 0 });
    for (let i = 0; i < input.data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        expect(Math.abs((out.data[i + c] ?? 0) - (input.data[i + c] ?? 0))).toBeLessThanOrEqual(1);
      }
      expect(out.data[i + 3]).toBe(255);
    }
  });

  it("draws only the shadow, offset from the object, when Only draw shadow is on", () => {
    const data = new Uint8ClampedArray(7 * 7 * 4);
    data.set([10, 20, 30, 255], (3 * 7 + 3) * 4);
    const out = dropShadowCpu(new Surface(7, 7, data), {
      ...DEFAULTS,
      radius: 0,
      distance: 2,
      angle: -90,
      opacity: 1,
      color: 0,
      onlyShadow: true,
    });
    const alphaAt = (x: number, y: number) => out.data[(y * 7 + x) * 4 + 3];
    expect(alphaAt(3, 3)).toBe(0);
    expect(alphaAt(3, 5)).toBe(255);
  });

  it("tints the shadow with its color and Opacity", () => {
    const data = new Uint8ClampedArray(5 * 5 * 4);
    data.set([0, 0, 0, 255], (2 * 5 + 2) * 4);
    const out = dropShadowCpu(new Surface(5, 5, data), {
      ...DEFAULTS,
      radius: 0,
      distance: 0,
      opacity: 0.5,
      color: 0xff_00_00,
      onlyShadow: true,
    });
    const at = (2 * 5 + 2) * 4;
    expect(out.data[at]).toBe(255);
    expect(out.data[at + 1]).toBe(0);
    expect(out.data[at + 3]).toBe(128);
  });

  it("returns a transparent image for a transparent input", () => {
    const out = dropShadowCpu(flat(4, 4, [9, 9, 9, 0]), DEFAULTS);
    expect([...out.data].every((value) => value === 0)).toBe(true);
  });
});

describe("Drop Shadow binding", () => {
  it("runs the CPU reference from its parameters", () => {
    const binding = dropShadowBinding();
    const out = binding.cpu(flat(4, 4, [51, 51, 51, 255]), binding.params({ radius: 2 }));
    expect(out.width).toBe(4);
    expect(out.height).toBe(4);
  });

  it("is registered among the built-in effects, after Outline", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids.at(-6)).toBe(DROP_SHADOW_ID);
    expect(ids.at(-7)).toBe("outline");
  });
});
