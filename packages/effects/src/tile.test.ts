/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { beforeAll, describe, expect, it } from "vitest";
import { builtinEffectBindings } from "./index";
import {
  TILE_REFLECTION_ID,
  tileReflectionBinding,
  tileReflectionCpu,
  tileReflectionDescriptor,
  tileReflectionParams,
  tileReflectionPlan,
  tileReflectionSchema,
} from "./tile";

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

describe("Tile Reflection descriptor and schema", () => {
  it("is a configurable Distort effect", () => {
    expect(tileReflectionDescriptor(2)).toMatchObject({
      id: TILE_REFLECTION_ID,
      label: "effect.tileReflection",
      category: "effect",
      submenu: "distort",
      configurable: true,
      kind: "gpuImage",
    });
  });

  it("lists Angle, Tile Size, Curvature, Quality and Edge Behavior, in the spec's order", () => {
    const schema = tileReflectionSchema(2);
    expect(schema.properties.map((property) => property.key)).toEqual([
      "angle",
      "tileSize",
      "curvature",
      "quality",
      "edge",
    ]);
    expect(schema.properties.find((property) => property.key === "angle")).toMatchObject({
      kind: "double",
      defaultValue: 30,
      min: -180,
      max: 180,
    });
    expect(schema.properties.find((property) => property.key === "tileSize")).toMatchObject({
      kind: "double",
      defaultValue: 40,
      min: 1,
      max: 1600,
    });
    expect(schema.properties.find((property) => property.key === "curvature")).toMatchObject({
      kind: "double",
      defaultValue: 8,
      min: -200,
      max: 200,
    });
    expect(schema.properties.find((property) => property.key === "edge")).toMatchObject({
      defaultValue: "reflect",
    });
  });

  it("takes the Quality default from the Default Quality Level, capped at 8", () => {
    const quality = tileReflectionSchema(9).properties.find(
      (property) => property.key === "quality",
    );
    expect(quality).toMatchObject({ kind: "int32", min: 1, max: 8, defaultValue: 8 });
  });
});

describe("Tile Reflection parameters and plan", () => {
  it("reads defaults and clamps values to the schema", () => {
    expect(tileReflectionParams({}, 3)).toEqual({
      angle: 30,
      tileSize: 40,
      curvature: 8,
      edge: "reflect",
      quality: 3,
      document: undefined,
      regionOrigin: undefined,
    });
    expect(tileReflectionParams({ angle: 500, tileSize: 0, curvature: -900 }, 3)).toMatchObject({
      angle: 180,
      tileSize: 1,
      curvature: -200,
    });
  });

  it("centers the wall on the selection when the selection is the document", () => {
    const plan = [...tileReflectionPlan(tileReflectionParams({}, 1), 40, 24)];
    expect(plan[0]).toBe(20);
    expect(plan[1]).toBe(12);
    expect(plan[2]).toBeCloseTo(Math.cos((-30 * Math.PI) / 180), 6);
    expect(plan[3]).toBeCloseTo(Math.sin((-30 * Math.PI) / 180), 6);
    expect(plan[4]).toBeCloseTo(Math.PI / 40, 6);
    // sign(8) · 8² / 10 = 6.4.
    expect(plan[5]).toBeCloseTo(6.4, 6);
  });

  it("centers the wall on the whole layer, not the region, when the region is offset", () => {
    const params = tileReflectionParams({}, 1, { width: 64, height: 48 }, { x: 10, y: 4 });
    const plan = [...tileReflectionPlan(params, 40, 24)];
    // The layer center is (32, 24), so in region coordinates it is (22, 20).
    expect(plan[0]).toBe(22);
    expect(plan[1]).toBe(20);
  });

  it("takes the sign of the curvature from its value", () => {
    const plan = [...tileReflectionPlan(tileReflectionParams({ curvature: -20 }, 1), 40, 24)];
    expect(plan[5]).toBeCloseTo(-40, 4);
  });
});

describe("Tile Reflection CPU reference", () => {
  it("returns the input when the curvature is zero", () => {
    const input = gradientImage(20, 12);
    const out = tileReflectionCpu(input, tileReflectionParams({ curvature: 0 }, 1));
    const differences = [...out.data].map((value, i) => Math.abs(value - (input.data[i] ?? 0)));
    expect(Math.max(...differences)).toBeLessThanOrEqual(1);
  });

  it("bends the image when the curvature is not zero", () => {
    const input = gradientImage(40, 24);
    const out = tileReflectionCpu(input, tileReflectionParams({}, 1));
    expect(out.data).not.toEqual(input.data);
  });

  it("keeps the opposite curvature signs apart", () => {
    const input = gradientImage(40, 24);
    const convex = tileReflectionCpu(input, tileReflectionParams({ curvature: 40 }, 1));
    const concave = tileReflectionCpu(input, tileReflectionParams({ curvature: -40 }, 1));
    expect(convex.data).not.toEqual(concave.data);
  });
});

describe("Tile Reflection binding", () => {
  it("passes the document size and the region's place in it through to the parameters", () => {
    const binding = tileReflectionBinding(1);
    const params = binding.params({ angle: -10 }, { width: 64, height: 48 }, 0, { x: 10, y: 4 });
    expect(params).toMatchObject({
      angle: -10,
      document: { width: 64, height: 48 },
      regionOrigin: { x: 10, y: 4 },
    });
    expect(binding.cpu(gradientImage(8, 8), params).width).toBe(8);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(TILE_REFLECTION_ID);
  });
});
