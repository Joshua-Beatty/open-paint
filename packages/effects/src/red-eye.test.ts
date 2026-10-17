/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  builtinEffectBindings,
  RED_EYE_ID,
  redEyeBinding,
  redEyeCpu,
  redEyeDescriptor,
  redEyeParams,
  redEyeSchema,
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

describe("Red Eye Removal descriptor and schema", () => {
  it("is a configurable CPU Photo effect that masks its own output", () => {
    expect(redEyeDescriptor()).toMatchObject({
      id: RED_EYE_ID,
      label: "effect.redEye",
      category: "effect",
      submenu: "photo",
      configurable: true,
      kind: "cpuRegion",
      options: { disableSelectionClipping: true },
    });
  });

  it("lists Strength 1-5 with default 3 and the selection hint under it", () => {
    const strength = redEyeSchema().properties.find((p) => p.key === "strength");
    expect(strength).toMatchObject({
      kind: "int32",
      defaultValue: 3,
      min: 1,
      max: 5,
      control: { description: "property.redEyeHint" },
    });
  });

  it("uses the defaults and clamps the strength to the schema", () => {
    expect(resolveValues(redEyeSchema(), {})).toMatchObject({ strength: 3 });
    expect(redEyeParams({ strength: 9 })).toEqual({ strength: 5 });
  });
});

describe("Red Eye Removal CPU reference", () => {
  it("corrects a red pixel and keeps its green, blue and alpha", () => {
    const out = redEyeCpu(flat(1, 1, [200, 40, 40, 255]), { strength: 3 });
    expect(out.data[0] ?? 0).toBeLessThan(200);
    expect(out.data[0] ?? 0).toBeGreaterThan(40);
    expect([...out.data.slice(1)]).toEqual([40, 40, 255]);
  });

  it("leaves a neutral gray untouched", () => {
    const input = flat(3, 3, [120, 120, 120, 255]);
    expect([...redEyeCpu(input, { strength: 5 }).data]).toEqual([...input.data]);
  });

  it("corrects the whole image when there is no selection", () => {
    const out = redEyeCpu(flat(2, 2, [200, 40, 40, 255]), { strength: 5 });
    expect(out.data[0] ?? 0).toBeLessThan(200);
  });

  it("corrects only the selected pixels", () => {
    const input = flat(2, 1, [200, 40, 40, 255]);
    const out = redEyeCpu(input, { strength: 5 }, new Uint8Array([255, 0]));
    expect(out.data[0] ?? 0).toBeLessThan(200);
    expect([...out.data.slice(4)]).toEqual([...input.data.slice(4)]);
  });

  it("returns a same-sized surface", () => {
    const out = redEyeCpu(flat(7, 4, [10, 200, 30, 255]), { strength: 2 });
    expect(out.width).toBe(7);
    expect(out.height).toBe(4);
  });
});

describe("Red Eye Removal binding", () => {
  it("runs the CPU reference from its parameters", () => {
    const binding = redEyeBinding();
    const out = binding.cpu(flat(4, 4, [51, 51, 51, 255]), binding.params({ strength: 4 }));
    expect(out.width).toBe(4);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(RED_EYE_ID);
  });
});
