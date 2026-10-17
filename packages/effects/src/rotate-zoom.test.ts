/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  builtinEffectBindings,
  planRotateZoom,
  ROTATE_ZOOM_ID,
  rotateZoomBinding,
  rotateZoomCpu,
  rotateZoomDescriptor,
  rotateZoomParams,
  rotateZoomSchema,
} from "./index";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

function gradient(width: number, height: number): Surface {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set([(x * 37) % 256, (y * 53) % 256, ((x + y) * 11) % 256, 255], (y * width + x) * 4);
    }
  }
  return new Surface(width, height, data);
}

const AT_REST = {
  roll: { x: 0, y: 0, z: 0 },
  pan: { x: 0, y: 0 },
  zoom: 1,
  sampling: "bilinear",
  quality: 1,
  tiling: "none",
} as const;

describe("Rotate / Zoom descriptor and schema", () => {
  it("is a hidden, configurable GPU image effect with no submenu", () => {
    expect(rotateZoomDescriptor(1)).toMatchObject({
      id: ROTATE_ZOOM_ID,
      label: "effect.rotateZoom",
      category: "hidden",
      configurable: true,
      kind: "gpuImage",
    });
    expect(rotateZoomDescriptor(1).submenu).toBeUndefined();
  });

  it("lists the controls in the spec's order with their defaults and ranges", () => {
    const keys = rotateZoomSchema(1).properties.map((property) => property.key);
    expect(keys).toEqual(["roll", "pan", "zoom", "sampling", "quality", "tiling"]);
    expect(resolveValues(rotateZoomSchema(2), {})).toMatchObject({
      roll: { x: 0, y: 0, z: 0 },
      pan: { x: 0, y: 0 },
      zoom: 1,
      sampling: "bilinear",
      quality: 2,
      tiling: "none",
    });
    const roll = rotateZoomSchema(1).properties[0];
    expect(roll).toMatchObject({ min: { x: -180, y: -180, z: 0 }, max: { x: 180, y: 180, z: 90 } });
  });

  it("clamps stored values to the schema", () => {
    const params = rotateZoomParams(
      { roll: { x: 400, y: -400, z: 120 }, zoom: 99, tiling: "mirror", quality: 40 },
      1,
    );
    expect(params.roll).toEqual({ x: 180, y: -180, z: 90 });
    expect(params.zoom).toBe(16);
    expect(params.tiling).toBe("mirror");
    expect(params.quality).toBe(8);
  });

  it("is registered among the built-in effects, after Quantize", () => {
    const bindings = builtinEffectBindings(1);
    expect(bindings.at(-1)?.descriptor.id).toBe(ROTATE_ZOOM_ID);
    expect(rotateZoomBinding(1).descriptor.id).toBe(ROTATE_ZOOM_ID);
  });
});

describe("Rotate / Zoom plan and CPU reference", () => {
  it("is the identity matrix at rest", () => {
    const plan = planRotateZoom(AT_REST_PARAMS(), 40, 24);
    expect(Array.from(plan)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 40, 0, 0, 1]);
  });

  it("reproduces the image at rest, at Quality 1", () => {
    const input = gradient(12, 8);
    const out = rotateZoomCpu(input, AT_REST_PARAMS());
    expect(Array.from(out.data)).toEqual(Array.from(input.data));
  });

  it("changes the image when the layer rolls", () => {
    const input = gradient(12, 8);
    const out = rotateZoomCpu(input, {
      ...AT_REST_PARAMS(),
      roll: { x: 30, y: 0, z: 0 },
    });
    expect(Array.from(out.data)).not.toEqual(Array.from(input.data));
    expect(out.width).toBe(12);
    expect(out.height).toBe(8);
  });
});

function AT_REST_PARAMS() {
  return rotateZoomParams(AT_REST, 1);
}
