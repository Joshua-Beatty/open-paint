/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BULGE_DEFAULT_STRENGTH,
  BULGE_ID,
  bulgeBinding,
  bulgeCpu,
  bulgeDescriptor,
  bulgeParams,
  bulgePlan,
  bulgeSchema,
} from "./bulge";
import { SOURCE_UNDERLAY_KEY } from "./distortion";
import { builtinEffectBindings } from "./index";

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

describe("Bulge descriptor and schema", () => {
  it("is a configurable Distort effect with the spec's default strength", () => {
    const descriptor = bulgeDescriptor(2);
    expect(descriptor).toMatchObject({
      id: BULGE_ID,
      label: "effect.bulge",
      category: "effect",
      submenu: "distort",
      configurable: true,
      kind: "gpuImage",
    });
    expect(BULGE_DEFAULT_STRENGTH).toBe(0.45);
  });

  it("lists Bulge, Center, Edge Behavior and Quality, in that order", () => {
    const schema = bulgeSchema(2);
    expect(schema.properties.map((property) => property.key)).toEqual([
      "bulge",
      "center",
      "edge",
      "quality",
    ]);
    expect(schema.properties.find((property) => property.key === "bulge")).toMatchObject({
      kind: "double",
      defaultValue: 0.45,
      min: -3,
      max: 1,
    });
    expect(schema.properties.find((property) => property.key === "center")).toMatchObject({
      kind: "vector2",
      defaultValue: { x: 0, y: 0 },
      min: { x: -1, y: -1 },
      max: { x: 1, y: 1 },
    });
    expect(schema.properties.find((property) => property.key === "edge")).toMatchObject({
      defaultValue: "clamp",
    });
  });

  it("draws the Center pad over the source thumbnail (FX-A-00-02e)", () => {
    const center = bulgeSchema(2).properties.find((property) => property.key === "center");
    expect(center?.control?.staticImageUnderlay).toBe(SOURCE_UNDERLAY_KEY);
  });

  it("takes the Quality default from the Default Quality Level, capped at 8", () => {
    const quality = (level: number) =>
      bulgeSchema(level).properties.find((property) => property.key === "quality");
    expect(quality(5)).toMatchObject({ kind: "int32", min: 1, max: 8, defaultValue: 5 });
    expect(quality(12)).toMatchObject({ defaultValue: 8 });
  });
});

describe("Bulge parameters and plan", () => {
  it("reads defaults and clamps values to the schema", () => {
    expect(bulgeParams({}, 2)).toEqual({
      bulge: 0.45,
      center: { x: 0, y: 0 },
      edge: "clamp",
      quality: 2,
    });
    const clamped = bulgeParams({ bulge: 9, center: { x: -5, y: 0.5 }, edge: "wrap" }, 2);
    expect(clamped).toMatchObject({ bulge: 1, center: { x: -1, y: 0.5 }, edge: "wrap" });
  });

  it("plans the center, radius and strength of the selection bounds", () => {
    const plan = bulgePlan(bulgeParams({ bulge: 0.45 }, 1), 40, 24);
    expect([...plan]).toEqual([20, 12, 12, Math.fround(0.45)]);
    const offset = bulgePlan(bulgeParams({ center: { x: 0.5, y: -1 } }, 1), 40, 24);
    expect([...offset]).toEqual([30, 0, 12, Math.fround(0.45)]);
  });
});

describe("Bulge CPU reference", () => {
  it("returns the input when the strength is zero", () => {
    const input = gradientImage(20, 12);
    const out = bulgeCpu(input, bulgeParams({ bulge: 0 }, 1));
    expect(out.width).toBe(20);
    const differences = [...out.data].map((value, i) => Math.abs(value - (input.data[i] ?? 0)));
    expect(Math.max(...differences)).toBeLessThanOrEqual(1);
  });

  it("leaves pixels outside the circle alone and moves those inside", () => {
    const input = gradientImage(40, 24);
    const swell = bulgeCpu(input, bulgeParams({ bulge: 0.45 }, 1));
    const corner = 0;
    expect([...swell.data.slice(corner, corner + 4)]).toEqual([
      ...input.data.slice(corner, corner + 4),
    ]);
    const center = (12 * 40 + 20) * 4;
    expect(swell.data[center]).not.toBe(input.data[center]);
  });

  it("swells and pinches in opposite directions", () => {
    const input = gradientImage(40, 24);
    const swell = bulgeCpu(input, bulgeParams({ bulge: 0.8 }, 1));
    const pinch = bulgeCpu(input, bulgeParams({ bulge: -0.8 }, 1));
    const pixel = (12 * 40 + 27) * 4;
    expect(swell.data[pixel]).not.toBe(pinch.data[pixel]);
  });
});

describe("Bulge binding", () => {
  it("reads its parameters and runs the CPU reference", () => {
    const binding = bulgeBinding(1);
    const params = binding.params({ bulge: -1, edge: "reflect" });
    expect(params).toMatchObject({ bulge: -1, edge: "reflect", quality: 1 });
    const out = binding.cpu(gradientImage(8, 8), params);
    expect(out.width).toBe(8);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(BULGE_ID);
  });
});
