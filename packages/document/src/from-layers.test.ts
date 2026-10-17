/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it } from "vitest";
import { LayerBlendMode } from "./blend-mode";
import { Document, type LayerSource } from "./document";
import { rect } from "./geometry";
import { Surface } from "./surface";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

function surface(width: number, height: number, value: number): Surface {
  return new Surface(width, height, new Uint8ClampedArray(width * height * 4).fill(value));
}

function source(name: string, value: number, extra: Partial<LayerSource> = {}): LayerSource {
  return {
    pixels: surface(3, 2, value),
    name,
    visible: true,
    opacity: 255,
    blendMode: LayerBlendMode.normal,
    isBackground: false,
    ...extra,
  };
}

describe("Document.fromLayers (FMT-NAT-11)", () => {
  it("keeps the layers bottom to top, with the selection and the active layer", () => {
    const doc = Document.fromLayers(
      3,
      2,
      [
        source("Background", 10, { isBackground: true }),
        source("Shadow", 20, { blendMode: LayerBlendMode.multiply, opacity: 128, visible: false }),
        source("Top", 30),
      ],
      {
        selection: { polygons: [[0, 0, 2, 0, 2, 2, 0, 2]], quality: "aliased" },
        activeIndex: 1,
      },
    );
    expect(doc.layers.map((layer) => layer.name)).toEqual(["Background", "Shadow", "Top"]);
    expect(doc.layers[0]?.isBackground).toBe(true);
    expect(doc.layers[1]?.opacity).toBe(128);
    expect(doc.layers[1]?.visible).toBe(false);
    expect(doc.layers[1]?.blendMode).toBe(LayerBlendMode.multiply);
    expect(doc.layers[1]?.pixels.readRegion(doc.layers[1].pixels.bounds).data[0]).toBe(20);
    expect(doc.activeLayer).toBe(doc.layers[1]);
    expect(doc.selection.polygons).toHaveLength(1);
    expect(doc.selection.bounds()).toEqual(rect(0, 0, 2, 2));
    expect(doc.selection.quality).toBe("aliased");
    doc.dispose();
  });

  it("makes the top layer active by default and starts clean", () => {
    const doc = Document.fromLayers(3, 2, [source("A", 1), source("B", 2)]);
    expect(doc.activeLayer).toBe(doc.layers[1]);
    expect(doc.selection.isEmpty).toBe(true);
    expect(doc.dirty).toBe(false);
    doc.dispose();
  });

  it("refuses an empty layer list and a layer of another size", () => {
    expect(() => Document.fromLayers(3, 2, [])).toThrow(RangeError);
    expect(() =>
      Document.fromLayers(3, 2, [{ ...source("A", 1), pixels: surface(2, 2, 0) }]),
    ).toThrow(RangeError);
  });

  it("marks the document dirty and clean again", () => {
    const doc = Document.fromLayers(3, 2, [source("A", 1)]);
    doc.markUnsaved();
    expect(doc.dirty).toBe(true);
    doc.markClean();
    expect(doc.dirty).toBe(false);
    doc.dispose();
  });

  it("keeps an unknown blend mode until the user sets a blend mode", () => {
    const doc = Document.fromLayers(3, 2, [
      source("A", 1, { rawBlendMode: 99, extras: { "x-tag": 1 } }),
    ]);
    const layer = doc.layers[0];
    expect(layer?.blendMode).toBe(LayerBlendMode.normal);
    expect(layer?.rawBlendMode).toBe(99);
    doc.setActiveLayerProperties({ opacity: 200 });
    expect(doc.layers[0]?.rawBlendMode).toBe(99);
    doc.setActiveLayerProperties({ blendMode: LayerBlendMode.normal });
    expect(doc.layers[0]?.rawBlendMode).toBeUndefined();
    doc.dispose();
  });

  it("copies the stored blend mode and the unknown keys when a layer is duplicated", () => {
    const doc = Document.fromLayers(3, 2, [
      source("A", 1, { rawBlendMode: 99, extras: { "x-tag": { n: 1 } } }),
    ]);
    const copy = doc.duplicateActiveLayer();
    expect(copy.rawBlendMode).toBe(99);
    expect(copy.extras).toEqual({ "x-tag": { n: 1 } });
    doc.dispose();
  });
});
