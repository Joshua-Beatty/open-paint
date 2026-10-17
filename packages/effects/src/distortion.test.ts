/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { definePropertySchema } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DISTORTION_MAX_QUALITY,
  distortAffineCpu,
  distortionQualityProperty,
  EDGE_BEHAVIORS,
  edgeBehaviorCode,
  edgeBehaviorProperty,
  planDistortionOffsets,
} from "./distortion";
import {
  AFFINE_SAMPLE_MAP_WGSL,
  DISTORTION_MAP_FLOATS,
  DISTORTION_PARAMS_BYTES,
  dentsSampleMapWgsl,
  distortionWgsl,
  TILE_SAMPLE_MAP_WGSL,
} from "./distortion-wgsl";
import { seedProperty } from "./rng";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

describe("distortion properties", () => {
  it("gives Quality the integer range 1-8 and caps the default at the effect's maximum", () => {
    expect(distortionQualityProperty(2)).toMatchObject({
      kind: "int32",
      min: 1,
      max: 8,
      defaultValue: 2,
    });
    expect(DISTORTION_MAX_QUALITY).toBe(8);
    expect(distortionQualityProperty(8, 5)).toMatchObject({ max: 5, defaultValue: 5 });
  });

  it("lists the edge modes in the engine's code order", () => {
    expect(EDGE_BEHAVIORS).toEqual(["clamp", "wrap", "reflect", "transparent"]);
    expect(EDGE_BEHAVIORS.map(edgeBehaviorCode)).toEqual([0, 1, 2, 3]);
    const edge = edgeBehaviorProperty("reflect");
    expect(edge.defaultValue).toBe("reflect");
    expect(edge.options.map((option) => option.value)).toEqual([...EDGE_BEHAVIORS]);
  });

  it("builds valid schemas from the shared properties", () => {
    expect(() =>
      definePropertySchema({
        properties: [distortionQualityProperty(2), edgeBehaviorProperty("clamp"), seedProperty()],
      }),
    ).not.toThrow();
  });
});

describe("Dents WGSL", () => {
  it("rounds the products of the rotation, fade and lerp before adding them", () => {
    // A fused multiply-add rounds once where Rust rounds twice; doubled over the octaves, that bit
    // moves a lookup to another noise cell (Firefox fuses these).
    const shader = dentsSampleMapWgsl().replace(/\/\/.*$/gm, "");
    expect(shader).not.toMatch(/c \* v\.x - s \* v\.y/);
    expect(shader).not.toMatch(/a \+ t \* \(b - a\)/);
    expect(shader).not.toMatch(/t \* 6\.0 - 15\.0/);
    expect(distortionWgsl(shader)).toContain("bitcast<u32>(x) ^ opaque_zero()");
  });
});

describe("Tile Reflection WGSL", () => {
  it("computes the tangent with Rust's own operations, not the GPU's approximate tan", () => {
    // WGSL's tan and division are approximate; near a pole the difference picks another tile.
    const shader = TILE_SAMPLE_MAP_WGSL.replace(/\/\/.*$/gm, "");
    expect(shader).not.toMatch(/\btan\(/);
    expect(shader).not.toMatch(/ \/ /);
    expect(shader).toContain("fn tile_tan(");
    expect(shader).toContain("0x7EF311C3u");
  });
});

describe("distortion engine (CPU reference)", () => {
  it("plans quality squared rotated-grid samples, one at the center for quality 1", () => {
    expect(Array.from(planDistortionOffsets(1))).toEqual([0, 0]);
    expect(planDistortionOffsets(3).length).toBe(9 * 2);
    expect(planDistortionOffsets(8).length).toBe(64 * 2);
  });

  it("leaves an opaque image unchanged under the identity map", () => {
    const data = new Uint8ClampedArray([
      10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 1, 2, 3, 255,
    ]);
    const input = new Surface(2, 2, data);
    const out = distortAffineCpu(input, [1, 0, 0, 1, 0, 0], 1, "clamp");
    expect(Array.from(out.data)).toEqual(Array.from(data));
  });

  it("maps out-of-image samples by the edge mode", () => {
    const data = new Uint8ClampedArray([10, 0, 0, 255, 200, 0, 0, 255]);
    const input = new Surface(2, 1, data);
    const shiftLeft = [1, 0, 0, 1, 1, 0];
    expect(distortAffineCpu(input, shiftLeft, 1, "wrap").data[4]).toBe(10);
    expect(distortAffineCpu(input, shiftLeft, 1, "clamp").data[4]).toBe(200);
    expect(Array.from(distortAffineCpu(input, shiftLeft, 1, "transparent").data.slice(4))).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it("packs the WGSL uniform to the layout the GPU runner writes", () => {
    expect(DISTORTION_PARAMS_BYTES).toBe(16 + 16 * 3);
    expect(DISTORTION_MAP_FLOATS).toBe(12);
    const shader = distortionWgsl(AFFINE_SAMPLE_MAP_WGSL);
    expect(shader).toContain("fn sample_map(");
    expect(shader).toContain("array<vec4<f32>, 3>");
    expect(shader).toContain("@workgroup_size(8, 8)");
  });
});
