/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { beforeAll, describe, expect, it } from "vitest";
import { SOURCE_UNDERLAY_KEY } from "./distortion";
import { builtinEffectBindings } from "./index";
import {
  TWIST_ID,
  twistBinding,
  twistCpu,
  twistDescriptor,
  twistParams,
  twistPlan,
  twistSchema,
} from "./twist";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

/** An opaque image whose red channel runs along x and green along y. */
function gradientImage(width: number, height: number): Surface {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data.set([(x * 255) / (width - 1), (y * 255) / (height - 1), 90, 255], i);
    }
  }
  return new Surface(width, height, data);
}

describe("Twist descriptor and schema", () => {
  it("is a configurable Distort effect", () => {
    expect(twistDescriptor(2)).toMatchObject({
      id: TWIST_ID,
      label: "effect.twist",
      category: "effect",
      submenu: "distort",
      configurable: true,
      kind: "gpuImage",
    });
  });

  it("lists Amount / Direction, Size, Center and Quality, with no Edge Behavior", () => {
    const schema = twistSchema(2);
    expect(schema.properties.map((property) => property.key)).toEqual([
      "amount",
      "size",
      "center",
      "quality",
    ]);
    expect(schema.properties.find((property) => property.key === "amount")).toMatchObject({
      kind: "int32",
      defaultValue: 30,
      min: -200,
      max: 200,
    });
    expect(schema.properties.find((property) => property.key === "size")).toMatchObject({
      kind: "double",
      defaultValue: 1,
      min: 0.01,
      max: 2,
    });
    expect(schema.properties.find((property) => property.key === "center")).toMatchObject({
      kind: "vector2",
      min: { x: -2, y: -2 },
      max: { x: 2, y: 2 },
    });
  });

  it("draws the Center pad over the source thumbnail (FX-A-00-02e)", () => {
    const center = twistSchema(2).properties.find((property) => property.key === "center");
    expect(center?.control?.staticImageUnderlay).toBe(SOURCE_UNDERLAY_KEY);
  });

  it("takes the Quality default from the Default Quality Level, capped at 8", () => {
    const quality = twistSchema(9).properties.find((property) => property.key === "quality");
    expect(quality).toMatchObject({ kind: "int32", min: 1, max: 8, defaultValue: 8 });
  });
});

describe("Twist parameters and plan", () => {
  it("reads defaults and clamps values to the schema", () => {
    expect(twistParams({}, 3)).toEqual({
      amount: 30,
      size: 1,
      center: { x: 0, y: 0 },
      quality: 3,
      document: undefined,
    });
    expect(twistParams({ amount: 900, size: 0, center: { x: 3, y: 0 } }, 3)).toMatchObject({
      amount: 200,
      size: 0.01,
      center: { x: 2, y: 0 },
    });
  });

  it("plans the center, the limit σ·Rmax and the gain τ / 100 radians", () => {
    const params = twistParams({ amount: 30 }, 1, { width: 80, height: 60 });
    const plan = [...twistPlan(params, 40, 24)];
    // Rmax = 12, σ = 1 · min(80, 60) / min(40, 24) = 2.5, so the limit is 30. a = -0.3 gives
    // τ = -900, a gain of -9 radians.
    expect(plan[0]).toBe(20);
    expect(plan[1]).toBe(12);
    expect(plan[2]).toBeCloseTo(30, 4);
    expect(plan[3]).toBeCloseTo(-9, 4);
  });

  it("does not scale the Size when the selection is the document", () => {
    const plan = [...twistPlan(twistParams({ amount: 30 }, 1), 40, 24)];
    expect(plan[2]).toBeCloseTo(12, 4);
  });
});

describe("Twist CPU reference", () => {
  it("returns the input when the amount is zero", () => {
    const input = gradientImage(20, 12);
    const out = twistCpu(input, twistParams({ amount: 0 }, 1));
    const differences = [...out.data].map((value, i) => Math.abs(value - (input.data[i] ?? 0)));
    expect(Math.max(...differences)).toBeLessThanOrEqual(1);
  });

  it("rotates the pixels inside the limit and keeps the outside", () => {
    const input = gradientImage(40, 24);
    const out = twistCpu(input, twistParams({ amount: 100, size: 1 }, 1));
    const corner = 0;
    expect([...out.data.slice(corner, corner + 4)]).toEqual([
      ...input.data.slice(corner, corner + 4),
    ]);
    const near = (12 * 40 + 24) * 4;
    expect(out.data[near]).not.toBe(input.data[near]);
  });

  it("scales the twist radius with the document, so a larger document twists differently", () => {
    const input = gradientImage(40, 24);
    const sameSize = twistCpu(input, twistParams({ amount: 100 }, 1, { width: 40, height: 24 }));
    const bigger = twistCpu(input, twistParams({ amount: 100 }, 1, { width: 160, height: 120 }));
    expect(sameSize.data).not.toEqual(bigger.data);
  });
});

describe("Twist binding", () => {
  it("passes the document size through to the parameters", () => {
    const binding = twistBinding(1);
    const params = binding.params({ amount: -50 }, { width: 200, height: 100 });
    expect(params).toMatchObject({ amount: -50, document: { width: 200, height: 100 } });
    expect(binding.cpu(gradientImage(8, 8), params).width).toBe(8);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(TWIST_ID);
  });
});
