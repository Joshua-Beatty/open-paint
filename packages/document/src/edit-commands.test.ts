/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it } from "vitest";
import { type ColorRgba8, rgba8, TRANSPARENT, WHITE } from "./color";
import { Document } from "./document";
import { rect } from "./geometry";
import type { Layer } from "./layer";
import { MemoryAccountant, OutOfMemoryError } from "./memory";
import { ellipsePolygon, rectPolygon } from "./selection-polygons";
import { TILE_BYTES } from "./tiled-store";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const RED = rgba8(255, 0, 0);
const BLUE = rgba8(0, 0, 255);

function layerAt(doc: Document, index: number): Layer {
  const layer = doc.layers[index];
  if (!layer) throw new Error(`missing layer ${index}`);
  return layer;
}

function pixel(layer: Layer, x: number, y: number): ColorRgba8 {
  return layer.pixels.getPixel(x, y);
}

describe("Erase Selection (DOC-SEL-06d)", () => {
  it("clears the whole active layer when nothing is selected", () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    doc.eraseSelection();
    const background = layerAt(doc, 0);
    expect(pixel(background, 0, 0)).toEqual(TRANSPARENT);
    expect(pixel(background, 7, 7)).toEqual(TRANSPARENT);
    expect(background.pixels.allocatedTileCount).toBe(0);
    expect(doc.history.undoName).toBe("Erase Selection");
    expect(doc.dirty).toBe(true);
  });

  it("clears only the selected pixels and then deselects, with undo and redo", async () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    doc.combineSelection([rectPolygon(rect(2, 2, 3, 3))], "replace");
    doc.eraseSelection();
    const background = layerAt(doc, 0);
    expect(pixel(background, 2, 2)).toEqual(TRANSPARENT);
    expect(pixel(background, 4, 4)).toEqual(TRANSPARENT);
    expect(pixel(background, 1, 1)).toEqual(WHITE);
    expect(pixel(background, 5, 5)).toEqual(WHITE);
    expect(doc.selection.isEmpty).toBe(true);

    expect(await doc.history.undo()).toBe(true);
    expect(pixel(background, 2, 2)).toEqual(WHITE);
    expect(doc.selection.bounds()).toEqual(rect(2, 2, 3, 3));

    expect(await doc.history.redo()).toBe(true);
    expect(pixel(background, 2, 2)).toEqual(TRANSPARENT);
    expect(doc.selection.isEmpty).toBe(true);
  });

  it("leaves the other layers alone", () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    const top = doc.addLayer();
    top.pixels.fill(RED);
    doc.setActiveLayer(layerAt(doc, 0));
    doc.combineSelection([rectPolygon(rect(2, 2, 3, 3))], "replace");
    doc.eraseSelection();
    expect(pixel(layerAt(doc, 0), 2, 2)).toEqual(TRANSPARENT);
    expect(pixel(top, 2, 2)).toEqual(RED);
  });

  it("weights antialiased edges by coverage", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.combineSelection([[0, 0, 2, 0, 0, 2]], "replace");
    doc.eraseSelection();
    const background = layerAt(doc, 0);
    expect(pixel(background, 0, 0).a).toBe(0);
    expect(pixel(background, 3, 3)).toEqual(WHITE);
    const edge = pixel(background, 1, 0).a;
    expect(edge).toBeGreaterThan(100);
    expect(edge).toBeLessThan(160);
  });

  it("does not allocate tiles for transparent areas", () => {
    const doc = Document.createBlank({ width: 300, height: 300 });
    const top = doc.addLayer();
    doc.selectAll();
    doc.eraseSelection();
    expect(top.pixels.allocatedTileCount).toBe(0);
  });
});

describe("Fill Selection (DOC-SEL-06e)", () => {
  it("fills the whole active layer when nothing is selected and keeps the empty selection", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.fillSelection(RED);
    const background = layerAt(doc, 0);
    expect(pixel(background, 0, 0)).toEqual(RED);
    expect(pixel(background, 3, 3)).toEqual(RED);
    expect(doc.selection.isEmpty).toBe(true);
    expect(doc.history.undoName).toBe("Fill Selection");
  });

  it("fills the selection and keeps it, with undo", async () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    doc.combineSelection([rectPolygon(rect(2, 2, 2, 2))], "replace");
    doc.fillSelection(BLUE);
    const background = layerAt(doc, 0);
    expect(pixel(background, 2, 2)).toEqual(BLUE);
    expect(pixel(background, 3, 3)).toEqual(BLUE);
    expect(pixel(background, 1, 1)).toEqual(WHITE);
    expect(pixel(background, 4, 4)).toEqual(WHITE);
    expect(doc.selection.bounds()).toEqual(rect(2, 2, 2, 2));

    expect(await doc.history.undo()).toBe(true);
    expect(pixel(background, 2, 2)).toEqual(WHITE);
    expect(doc.selection.bounds()).toEqual(rect(2, 2, 2, 2));
  });

  it("overwrites the destination, alpha included, instead of compositing", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.fillSelection(rgba8(0, 0, 0, 128));
    expect(pixel(layerAt(doc, 0), 1, 1)).toEqual(rgba8(0, 0, 0, 128));
  });

  it("blends antialiased edges by coverage", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.combineSelection([[0, 0, 2, 0, 0, 2]], "replace");
    doc.fillSelection(rgba8(0, 0, 0, 255));
    const edge = pixel(layerAt(doc, 0), 1, 0).r;
    expect(edge).toBeGreaterThan(100);
    expect(edge).toBeLessThan(160);
    expect(pixel(layerAt(doc, 0), 0, 0)).toEqual(rgba8(0, 0, 0, 255));
    expect(pixel(layerAt(doc, 0), 3, 3)).toEqual(WHITE);
  });
});

describe("Crop to Selection (DOC-IMG-01)", () => {
  it("does nothing without a selection", () => {
    const doc = Document.createBlank({ width: 16, height: 16 });
    expect(doc.cropToSelection()).toBe(false);
    expect(doc.width).toBe(16);
    expect(doc.history.entries.length).toBe(1);
    expect(doc.dirty).toBe(false);
  });

  it("crops every layer to a rectangular selection and moves the selection with the content", () => {
    const doc = Document.createBlank({ width: 16, height: 16 });
    const top = doc.addLayer();
    top.pixels.fill(RED);
    doc.setActiveLayerProperties({ opacity: 128 });
    doc.combineSelection([rectPolygon(rect(4, 5, 6, 7))], "replace");

    expect(doc.cropToSelection()).toBe(true);
    expect(doc.width).toBe(6);
    expect(doc.height).toBe(7);
    expect(doc.history.undoName).toBe("Crop to Selection");
    for (const layer of doc.layers) {
      expect(layer.pixels.width).toBe(6);
      expect(layer.pixels.height).toBe(7);
    }
    expect(pixel(layerAt(doc, 0), 0, 0)).toEqual(WHITE);
    expect(pixel(layerAt(doc, 0), 5, 6)).toEqual(WHITE);
    expect(pixel(top, 0, 0)).toEqual(RED);
    expect(top.name).toBe("Layer 2");
    expect(top.opacity).toBe(128);
    expect(doc.selection.bounds()).toEqual(rect(0, 0, 6, 7));
  });

  it("clips the crop to the canvas", () => {
    const doc = Document.createBlank({ width: 16, height: 16 });
    doc.combineSelection([rectPolygon(rect(-5, -5, 10, 10))], "replace");
    expect(doc.cropToSelection()).toBe(true);
    expect(doc.width).toBe(5);
    expect(doc.height).toBe(5);
    expect(pixel(layerAt(doc, 0), 4, 4)).toEqual(WHITE);
  });

  it("makes pixels outside a non-rectangular selection transparent", () => {
    const doc = Document.createBlank({ width: 16, height: 16 });
    doc.setSelectionQuality("aliased");
    doc.combineSelection([[2, 2, 10, 2, 2, 10]], "replace");
    expect(doc.cropToSelection()).toBe(true);
    const background = layerAt(doc, 0);
    expect(doc.width).toBe(8);
    expect(pixel(background, 0, 0)).toEqual(WHITE);
    expect(pixel(background, 6, 0)).toEqual(WHITE);
    expect(pixel(background, 7, 7).a).toBe(0);
  });

  it("keeps antialiased edges as partial alpha", () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    doc.combineSelection([[0, 0, 4, 0, 0, 4]], "replace");
    expect(doc.cropToSelection()).toBe(true);
    const alpha = pixel(layerAt(doc, 0), 3, 0).a;
    expect(alpha).toBeGreaterThan(100);
    expect(alpha).toBeLessThan(160);
    expect(pixel(layerAt(doc, 0), 0, 0).a).toBe(255);
  });

  it("crops an ellipse over two layers to its bounds and clears outside it, as one step", async () => {
    const doc = Document.createBlank({ width: 40, height: 30 });
    const top = doc.addLayer();
    top.pixels.fill(RED);
    doc.combineSelection([ellipsePolygon(rect(5, 4, 20, 16))], "replace");
    const entries = doc.history.entries.length;
    expect(doc.cropToSelection()).toBe(true);
    expect(doc.history.entries.length).toBe(entries + 1);
    expect(doc.history.undoName).toBe("Crop to Selection");
    expect(doc.width).toBe(20);
    expect(doc.height).toBe(16);
    for (const layer of doc.layers) {
      expect(layer.pixels.width).toBe(20);
      // Inside the ellipse the layer keeps its pixels; its corners are outside and become clear.
      expect(pixel(layer, 10, 8).a).toBe(255);
      expect(pixel(layer, 0, 0).a).toBe(0);
      expect(pixel(layer, 19, 15).a).toBe(0);
      // The antialiased edge keeps partial alpha.
      const edge = [...Array(10).keys()].map((x) => pixel(layer, x, 2).a);
      expect(edge.some((a) => a > 0 && a < 255)).toBe(true);
    }
    expect(pixel(layerAt(doc, 0), 10, 8)).toEqual(WHITE);
    expect(pixel(top, 10, 8)).toEqual(RED);

    expect(await doc.history.undo()).toBe(true);
    expect(doc.width).toBe(40);
    expect(pixel(top, 5, 4)).toEqual(RED);
    expect(pixel(layerAt(doc, 0), 5, 4)).toEqual(WHITE);
  });

  it("restores the size, pixels and selection on undo and reapplies them on redo", async () => {
    const doc = Document.createBlank({ width: 16, height: 16 });
    doc.combineSelection([rectPolygon(rect(4, 5, 6, 7))], "replace");
    doc.cropToSelection();

    expect(await doc.history.undo()).toBe(true);
    expect(doc.width).toBe(16);
    expect(doc.height).toBe(16);
    expect(layerAt(doc, 0).pixels.width).toBe(16);
    expect(pixel(layerAt(doc, 0), 15, 15)).toEqual(WHITE);
    expect(doc.selection.bounds()).toEqual(rect(4, 5, 6, 7));

    expect(await doc.history.redo()).toBe(true);
    expect(doc.width).toBe(6);
    expect(doc.height).toBe(7);
    expect(doc.selection.bounds()).toEqual(rect(0, 0, 6, 7));
  });

  it("leaves the document unchanged when the new pixels cannot be allocated", () => {
    const accountant = new MemoryAccountant(TILE_BYTES);
    const doc = Document.createBlank({ width: 16, height: 16, accountant });
    doc.combineSelection([rectPolygon(rect(0, 0, 8, 8))], "replace");
    const entries = doc.history.entries.length;
    expect(() => doc.cropToSelection()).toThrow(OutOfMemoryError);
    expect(doc.width).toBe(16);
    expect(layerAt(doc, 0).pixels.width).toBe(16);
    expect(pixel(layerAt(doc, 0), 15, 15)).toEqual(WHITE);
    expect(doc.history.entries.length).toBe(entries);
    expect(doc.history.undoName).toBe("Edit Selection");
  });
});
