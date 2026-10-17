/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  builtinEffectBindings,
  EMBOSS_ID,
  embossBinding,
  embossCpu,
  embossDescriptor,
  embossParams,
  embossSchema,
  planEmboss,
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

describe("Emboss descriptor and schema", () => {
  it("is a configurable Stylize effect in document space", () => {
    expect(embossDescriptor()).toMatchObject({
      id: EMBOSS_ID,
      label: "effect.emboss",
      category: "effect",
      submenu: "stylize",
      configurable: true,
      kind: "gpuImage",
      options: { gpu: { workingSpace: "document", inputAlpha: "straight" } },
    });
  });

  it("has one angle chooser from 0 to 360 degrees, defaulting to 0", () => {
    expect(embossSchema().properties).toHaveLength(1);
    expect(embossSchema().properties[0]).toMatchObject({
      key: "angle",
      kind: "double",
      defaultValue: 0,
      min: 0,
      max: 360,
      control: { controlType: "anglePicker" },
    });
    expect(resolveValues(embossSchema(), {})).toMatchObject({ angle: 0 });
    expect(embossParams({ angle: 400 })).toEqual({ angle: 360 });
  });
});

describe("Emboss CPU reference", () => {
  it("turns a flat image into opaque mid gray", () => {
    const out = embossCpu(flat(3, 3, [10, 200, 30, 255]), { angle: 0 });
    expect([...out.data.slice(0, 4)]).toEqual([128, 128, 128, 255]);
    expect(out.data.every((value, i) => i % 4 !== 3 || value === 255)).toBe(true);
  });

  it("lights the right side of a dark-to-light step at 0 degrees", () => {
    const input = new Surface(
      4,
      1,
      new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255]),
    );
    const out = embossCpu(input, { angle: 0 });
    expect(out.data[1 * 4] ?? 0).toBe(255);
  });

  it("gives a plan that matches the reference's kernel size", () => {
    expect(planEmboss({ angle: 90 }).weights).toHaveLength(9);
  });
});

describe("Emboss binding", () => {
  it("runs the CPU reference from its parameters", () => {
    const binding = embossBinding();
    const out = binding.cpu(flat(4, 4, [51, 51, 51, 255]), binding.params({ angle: 135 }));
    expect(out.width).toBe(4);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(EMBOSS_ID);
  });
});
