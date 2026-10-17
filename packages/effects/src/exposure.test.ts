/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  EXPOSURE_OP,
  exposureBinding,
  exposureCpu,
  exposureDescriptor,
  exposureParams,
  exposurePlan,
  exposureSchema,
} from "./exposure";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

function grays(values: readonly number[], alpha = 255): Surface {
  return new Surface(
    values.length,
    1,
    new Uint8ClampedArray(values.flatMap((v) => [v, v, v, alpha])),
  );
}

describe("Exposure descriptor (ADJ-EXPOSURE)", () => {
  it("is a configurable adjustment with one slider from -200 to 200", () => {
    expect(exposureDescriptor()).toMatchObject({
      id: "exposure",
      category: "adjustment",
      configurable: true,
      kind: "gpuImage",
    });
    const [exposure] = exposureSchema().properties;
    expect(exposure).toMatchObject({
      kind: "int32",
      key: "exposure",
      defaultValue: 0,
      min: -200,
      max: 200,
    });
  });

  it("clamps stored values to the schema", () => {
    expect(exposureParams({ exposure: 900 })).toEqual({ exposure: 200 });
    expect(resolveValues(exposureSchema(), {}).exposure).toBe(0);
  });

  it("registers as a binding with the same descriptor", () => {
    expect(exposureBinding().descriptor.id).toBe("exposure");
  });
});

describe("Exposure math (ADJ-EXPOSURE-01)", () => {
  it("is the identity at 0", () => {
    const src = grays([0, 17, 128, 255]);
    expect([...exposureCpu(src, { exposure: 0 }).data]).toEqual([...src.data]);
  });

  it("plans a linear-light gain of 2^EV on every channel", () => {
    const plan = exposurePlan({ exposure: -100 });
    expect(plan.op).toBe(EXPOSURE_OP);
    expect([...plan.gains]).toEqual([0.5, 0.5, 0.5]);
  });

  it("brightens midtones and keeps alpha, including for transparent pixels", () => {
    const out = exposureCpu(grays([64], 0), { exposure: 100 });
    expect(out.data[0]).toBeGreaterThan(64);
    expect(out.data[3]).toBe(0);
  });

  it("clips highlights to white", () => {
    const out = exposureCpu(grays([200]), { exposure: 200 });
    expect(out.data[0]).toBe(255);
  });
});
