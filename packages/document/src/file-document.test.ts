/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it } from "vitest";
import { Document } from "./document";
import { Surface } from "./surface";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

function solid(width: number, height: number, color: { r: number; g: number; b: number }): Surface {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = color.r;
    data[i + 1] = color.g;
    data[i + 2] = color.b;
    data[i + 3] = 255;
  }
  return new Surface(width, height, data);
}

describe("Document.fromSurface (FMT-OPEN-01)", () => {
  it("sizes the document to the surface and keeps its pixels in one Background layer", () => {
    const pixels = solid(5, 3, { r: 10, g: 20, b: 30 });
    const doc = Document.fromSurface(pixels, {});
    expect(doc.width).toBe(5);
    expect(doc.height).toBe(3);
    expect(doc.layerCount).toBe(1);
    expect(doc.layers[0]?.name).toBe("Background");
    expect(doc.dirty).toBe(false);
    expect(doc.composite().data).toEqual(pixels.data);
  });

  it("keeps the resolution and color profile it is given", () => {
    const resolution = { x: 300, y: 300, unit: "inch" as const };
    const doc = Document.fromSurface(solid(2, 2, { r: 0, g: 0, b: 0 }), { resolution });
    expect(doc.resolution).toEqual(resolution);
    expect(doc.colorProfile).toBe("srgb");
  });
});

describe("Document.composite (FMT-SAVE-06)", () => {
  it("returns the whole canvas, even when a selection covers part of it", () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    doc.combineSelection([[0, 0, 4, 0, 4, 4, 0, 4]], "replace");
    const composite = doc.composite();
    expect(composite.width).toBe(8);
    expect(composite.height).toBe(8);
    expect(composite.data.slice(0, 4)).toEqual(new Uint8ClampedArray([255, 255, 255, 255]));
    expect(composite.data.slice(-4)).toEqual(new Uint8ClampedArray([255, 255, 255, 255]));
  });

  it("leaves hidden layers out", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.setActiveLayerProperties({ visible: false });
    expect(doc.composite().data.every((byte) => byte === 0)).toBe(true);
  });

  it("composites the visible layers over the canvas", () => {
    const doc = Document.fromSurface(solid(2, 2, { r: 1, g: 2, b: 3 }));
    expect(doc.composite().data.slice(0, 4)).toEqual(new Uint8ClampedArray([1, 2, 3, 255]));
  });
});
