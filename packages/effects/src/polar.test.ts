/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { beforeAll, describe, expect, it } from "vitest";
import { SOURCE_UNDERLAY_KEY } from "./distortion";
import { builtinEffectBindings } from "./index";
import {
  POLAR_INVERSION_ID,
  polarInversionBinding,
  polarInversionCpu,
  polarInversionDescriptor,
  polarInversionParams,
  polarInversionPlan,
  polarInversionSchema,
} from "./polar";

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

describe("Polar Inversion descriptor and schema", () => {
  it("is a configurable Distort effect", () => {
    expect(polarInversionDescriptor(2)).toMatchObject({
      id: POLAR_INVERSION_ID,
      label: "effect.polarInversion",
      category: "effect",
      submenu: "distort",
      configurable: true,
      kind: "gpuImage",
    });
  });

  it("lists Scale, Offset, Edge Behavior and Quality, in the spec's order", () => {
    const schema = polarInversionSchema(2);
    expect(schema.properties.map((property) => property.key)).toEqual([
      "scale",
      "offset",
      "edge",
      "quality",
    ]);
    expect(schema.properties.find((property) => property.key === "scale")).toMatchObject({
      kind: "double",
      defaultValue: 1,
      min: -8,
      max: 8,
    });
    expect(schema.properties.find((property) => property.key === "offset")).toMatchObject({
      kind: "vector2",
      defaultValue: { x: 0, y: 0 },
      min: { x: -2, y: -2 },
      max: { x: 2, y: 2 },
    });
    expect(schema.properties.find((property) => property.key === "edge")).toMatchObject({
      defaultValue: "reflect",
    });
  });

  it("draws the Offset pad over the source thumbnail (FX-A-00-02e)", () => {
    const offset = polarInversionSchema(2).properties.find((property) => property.key === "offset");
    expect(offset?.control?.staticImageUnderlay).toBe(SOURCE_UNDERLAY_KEY);
  });

  it("takes the Quality default from the Default Quality Level, capped at 8", () => {
    const quality = polarInversionSchema(9).properties.find(
      (property) => property.key === "quality",
    );
    expect(quality).toMatchObject({ kind: "int32", min: 1, max: 8, defaultValue: 8 });
  });
});

describe("Polar Inversion parameters and plan", () => {
  it("reads defaults and clamps values to the schema", () => {
    expect(polarInversionParams({}, 3)).toEqual({
      scale: 1,
      offset: { x: 0, y: 0 },
      edge: "reflect",
      quality: 3,
      document: undefined,
    });
    expect(polarInversionParams({ scale: 99, offset: { x: -5, y: 0 } }, 3)).toMatchObject({
      scale: 8,
      offset: { x: -2, y: 0 },
    });
  });

  it("plans the center, the radius of the smaller side, and the document-scaled Scale", () => {
    const params = polarInversionParams({}, 1, { width: 80, height: 60 });
    const plan = [...polarInversionPlan(params, 40, 24)];
    // The radius is min(40, 24) / 2 = 12, and the scale is 1 · min(80, 60) / 24 = 2.5.
    expect(plan).toEqual([20, 12, 12, 2.5]);
  });

  it("does not scale the Scale when the selection is the document", () => {
    const plan = [...polarInversionPlan(polarInversionParams({}, 1), 40, 24)];
    expect(plan[3]).toBe(1);
  });
});

describe("Polar Inversion CPU reference", () => {
  it("returns the input when the Scale is zero", () => {
    const input = gradientImage(20, 12);
    const out = polarInversionCpu(input, polarInversionParams({ scale: 0 }, 1));
    const differences = [...out.data].map((value, i) => Math.abs(value - (input.data[i] ?? 0)));
    expect(Math.max(...differences)).toBeLessThanOrEqual(1);
  });

  it("replaces the pixels around the center with samples from far away", () => {
    const input = gradientImage(40, 24);
    const out = polarInversionCpu(input, polarInversionParams({}, 1));
    const near = (12 * 40 + 26) * 4;
    expect(out.data[near]).not.toBe(input.data[near]);
    expect(out.data[3]).toBe(255);
  });

  it("scales the inversion with the document, so a larger document inverts differently", () => {
    const input = gradientImage(40, 24);
    const sameSize = polarInversionCpu(
      input,
      polarInversionParams({ scale: 2 }, 1, { width: 40, height: 24 }),
    );
    const bigger = polarInversionCpu(
      input,
      polarInversionParams({ scale: 2 }, 1, { width: 160, height: 120 }),
    );
    expect(sameSize.data).not.toEqual(bigger.data);
  });
});

describe("Polar Inversion binding", () => {
  it("passes the document size through to the parameters", () => {
    const binding = polarInversionBinding(1);
    const params = binding.params({ scale: -2 }, { width: 200, height: 100 });
    expect(params).toMatchObject({ scale: -2, document: { width: 200, height: 100 } });
    expect(binding.cpu(gradientImage(8, 8), params).width).toBe(8);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(POLAR_INVERSION_ID);
  });
});
