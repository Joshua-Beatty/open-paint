/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it } from "vitest";
import { ClipboardError, type ClipboardImage } from "./clipboard";
import { type ColorRgba8, rgba8, TRANSPARENT, WHITE } from "./color";
import { Document } from "./document";
import { rect } from "./geometry";
import type { Layer } from "./layer";
import { Selection } from "./selection";
import { rectPolygon } from "./selection-polygons";
import { Surface } from "./surface";

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

/** The area and bounds of a copied outline, which do not depend on how Clipper orders vertices. */
function outlineOf(copied: ClipboardImage | undefined) {
  const selection = new Selection(copied?.outline ?? []);
  return { area: selection.area(), bounds: selection.bounds() };
}

/** A `width` x `height` clipboard image filled with `color`. */
function solid(width: number, height: number, color: ColorRgba8): ClipboardImage {
  const pixels = new Surface(width, height);
  pixels.fill(color);
  return { pixels };
}

describe("Copy and Copy Merged (DOC-CLP-01b/c)", () => {
  it("copies the selection's bounds and clips alpha to the selection", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.combineSelection([[0, 0, 4, 0, 0, 4]], "replace");
    const copied = doc.copyPixels(false);
    expect(copied?.origin).toEqual({ x: 0, y: 0 });
    expect(copied?.pixels.getPixel(0, 0)).toEqual(WHITE);
    expect(copied?.pixels.getPixel(3, 3).a).toBe(0);
    expect(outlineOf(copied)).toEqual({ area: 8, bounds: rect(0, 0, 4, 4) });
  });

  it("moves the copied outline into bitmap coordinates", () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    doc.combineSelection([rectPolygon(rect(2, 3, 4, 2))], "replace");
    const copied = doc.copyPixels(false);
    expect(copied?.origin).toEqual({ x: 2, y: 3 });
    expect(copied?.pixels.width).toBe(4);
    expect(copied?.pixels.height).toBe(2);
    expect(outlineOf(copied)).toEqual({ area: 8, bounds: rect(0, 0, 4, 2) });
  });

  it("copies the whole canvas, with no outline, when nothing is selected", () => {
    const doc = Document.createBlank({ width: 3, height: 2 });
    const copied = doc.copyPixels(false);
    expect(copied?.pixels.width).toBe(3);
    expect(copied?.origin).toEqual({ x: 0, y: 0 });
    expect(copied?.outline).toBeUndefined();
    expect(doc.history.undoName).toBeUndefined();
  });

  it("copies the active layer only, unless merged", () => {
    const doc = Document.createBlank({ width: 2, height: 2 });
    const top = doc.addLayer();
    top.pixels.fill(RED);
    doc.setActiveLayer(layerAt(doc, 0));
    expect(doc.copyPixels(false)?.pixels.getPixel(0, 0)).toEqual(WHITE);
    expect(doc.copyPixels(true)?.pixels.getPixel(0, 0)).toEqual(RED);
  });

  it("leaves hidden layers out of a merged copy", () => {
    const doc = Document.createBlank({ width: 2, height: 2 });
    const top = doc.addLayer();
    top.pixels.fill(RED);
    top.applyProperties({ visible: false });
    expect(doc.copyPixels(true)?.pixels.getPixel(0, 0)).toEqual(WHITE);
  });

  it("does not record a history item", () => {
    const doc = Document.createBlank({ width: 2, height: 2 });
    doc.copyPixels(false);
    expect(doc.history.undoName).toBeUndefined();
    expect(doc.history.entries).toHaveLength(1);
  });
});

describe("Cut (DOC-CLP-01a)", () => {
  it("returns the copied pixels and erases the selection as one undoable item", async () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.combineSelection([rectPolygon(rect(1, 1, 2, 2))], "replace");
    const cut = doc.cutSelection();
    expect(cut?.pixels.getPixel(0, 0)).toEqual(WHITE);
    expect(pixel(layerAt(doc, 0), 1, 1)).toEqual(TRANSPARENT);
    expect(doc.history.undoName).toBe("Cut");
    expect(await doc.history.undo()).toBe(true);
    expect(pixel(layerAt(doc, 0), 1, 1)).toEqual(WHITE);
    expect(doc.selection.bounds()).toEqual(rect(1, 1, 2, 2));
  });
});

describe("Paste (DOC-CLP-01e)", () => {
  it("places the pasted pixels on the active layer and selects them", async () => {
    const doc = Document.createBlank({ width: 6, height: 6 });
    doc.pasteImage(solid(2, 2, RED), { x: 1, y: 1 });
    const background = layerAt(doc, 0);
    expect(pixel(background, 1, 1)).toEqual(RED);
    expect(pixel(background, 2, 2)).toEqual(RED);
    expect(pixel(background, 0, 0)).toEqual(WHITE);
    expect(pixel(background, 3, 3)).toEqual(WHITE);
    expect(doc.selection.bounds()).toEqual(rect(1, 1, 2, 2));
    expect(doc.history.undoName).toBe("Paste");

    expect(await doc.history.undo()).toBe(true);
    expect(pixel(background, 1, 1)).toEqual(WHITE);
    expect(doc.selection.isEmpty).toBe(true);
    expect(await doc.history.redo()).toBe(true);
    expect(pixel(background, 1, 1)).toEqual(RED);
  });

  it("replaces the target inside the pasted outline, transparent pixels included", () => {
    const doc = Document.createBlank({ width: 4, height: 2 });
    const pixels = new Surface(3, 1);
    pixels.setPixel(0, 0, RED);
    pixels.setPixel(1, 0, rgba8(0, 0, 255, 128));
    doc.pasteImage({ pixels }, { x: 0, y: 0 });
    expect(pixel(layerAt(doc, 0), 0, 0)).toEqual(RED);
    expect(pixel(layerAt(doc, 0), 1, 0)).toEqual(rgba8(0, 0, 255, 128));
    expect(pixel(layerAt(doc, 0), 2, 0)).toEqual(TRANSPARENT);
    expect(pixel(layerAt(doc, 0), 3, 0)).toEqual(WHITE);
  });

  it("keeps the target outside the pasted outline", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    const image = { ...solid(4, 4, TRANSPARENT), outline: [rectPolygon(rect(0, 0, 2, 4))] };
    doc.pasteImage(image, { x: 0, y: 0 });
    expect(pixel(layerAt(doc, 0), 1, 1)).toEqual(TRANSPARENT);
    expect(pixel(layerAt(doc, 0), 2, 1)).toEqual(WHITE);
  });

  it("pastes an antialiased copy back where it came from unchanged", () => {
    const doc = Document.createBlank({ width: 8, height: 4 });
    const layer = layerAt(doc, 0);
    const red = new Surface(8, 4);
    red.fill(RED);
    doc.editLayerPixels("paint", layer, rect(0, 0, 8, 4), (pixels) => {
      pixels.writeRegion(red, 0, 0);
    });
    doc.combineSelection([[0, 0, 4, 0, 5, 4, 0, 4]], "replace");
    const copied = doc.copyPixels(false);
    if (copied === undefined) throw new Error("nothing copied");
    // The copied edge is half clear. Pasted over the opaque red it came from, it blends back to red.
    expect(copied.pixels.getPixel(4, 0).a).toBeLessThan(255);
    doc.pasteImage(copied, { x: 0, y: 0 });
    expect(pixel(layer, 4, 0)).toEqual(RED);
    expect(pixel(layer, 3, 0)).toEqual(RED);
  });

  it("clips the pasted image to the canvas", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.pasteImage(solid(3, 3, RED), { x: 2, y: 2 });
    expect(pixel(layerAt(doc, 0), 3, 3)).toEqual(RED);
    expect(doc.selection.bounds()).toEqual(rect(2, 2, 3, 3));
  });

  it("pastes outside the canvas without changing any pixel", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.pasteImage(solid(2, 2, RED), { x: 9, y: 9 });
    expect(pixel(layerAt(doc, 0), 3, 3)).toEqual(WHITE);
  });

  it("uses the paste's outline as the selection, translated to the paste position", () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    const image = { ...solid(4, 4, RED), outline: [[0, 0, 4, 0, 0, 4]] };
    doc.pasteImage(image, { x: 2, y: 3 });
    expect(doc.selection.bounds()).toEqual(rect(2, 3, 4, 4));
    expect(doc.selection.area()).toBe(8);
  });
});

describe("Paste into New Layer (DOC-CLP-01f)", () => {
  it("adds a layer above the active one and pastes into it", async () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.pasteImage(solid(2, 2, RED), { x: 0, y: 0 }, { newLayer: true });
    expect(doc.layerCount).toBe(2);
    expect(doc.activeLayer).toBe(layerAt(doc, 1));
    expect(pixel(layerAt(doc, 1), 1, 1)).toEqual(RED);
    expect(pixel(layerAt(doc, 1), 3, 3)).toEqual(TRANSPARENT);
    expect(pixel(layerAt(doc, 0), 0, 0)).toEqual(WHITE);
    expect(doc.history.undoName).toBe("Paste into New Layer");

    expect(await doc.history.undo()).toBe(true);
    expect(doc.layerCount).toBe(1);
  });
});

describe("Expand canvas on paste (DOC-CLP-05)", () => {
  it("grows the canvas top-left anchored and pastes, as one Canvas Size item", async () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.pasteImage(solid(6, 2, RED), { x: 0, y: 0 }, { expandTo: { width: 6, height: 4 } });
    expect(doc.width).toBe(6);
    expect(doc.height).toBe(4);
    expect(pixel(layerAt(doc, 0), 0, 0)).toEqual(RED);
    expect(pixel(layerAt(doc, 0), 5, 0)).toEqual(RED);
    expect(pixel(layerAt(doc, 0), 1, 3)).toEqual(WHITE);
    expect(pixel(layerAt(doc, 0), 5, 3)).toEqual(TRANSPARENT);
    expect(doc.history.undoName).toBe("Canvas Size");

    expect(await doc.history.undo()).toBe(true);
    expect(doc.width).toBe(4);
    expect(doc.height).toBe(4);
    expect(pixel(layerAt(doc, 0), 0, 0)).toEqual(WHITE);
    expect(await doc.history.redo()).toBe(true);
    expect(doc.width).toBe(6);
  });

  it("can expand while pasting into a new layer", () => {
    const doc = Document.createBlank({ width: 2, height: 2 });
    doc.pasteImage(
      solid(3, 3, BLUE),
      { x: 0, y: 0 },
      { newLayer: true, expandTo: { width: 3, height: 3 } },
    );
    expect(doc.width).toBe(3);
    expect(doc.layerCount).toBe(2);
    expect(pixel(layerAt(doc, 1), 2, 2)).toEqual(BLUE);
    expect(pixel(layerAt(doc, 0), 2, 2)).toEqual(TRANSPARENT);
  });

  it("refuses to shrink the canvas", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    expect(() =>
      doc.pasteImage(solid(1, 1, RED), { x: 0, y: 0 }, { expandTo: { width: 3, height: 4 } }),
    ).toThrow(RangeError);
    expect(doc.width).toBe(4);
  });
});

describe("Paste into New Image (DOC-CLP-01g)", () => {
  it("creates a document sized to the image with one Background layer", async () => {
    const pixels = new Surface(3, 2);
    pixels.setPixel(0, 0, RED);
    const doc = Document.fromClipboardImage({ pixels });
    expect(doc.width).toBe(3);
    expect(doc.height).toBe(2);
    expect(doc.layerCount).toBe(1);
    expect(layerAt(doc, 0).name).toBe("Background");
    expect(pixel(layerAt(doc, 0), 0, 0)).toEqual(RED);
    expect(pixel(layerAt(doc, 0), 2, 1)).toEqual(TRANSPARENT);
    expect(doc.selection.isEmpty).toBe(true);
    expect(doc.history.entries).toEqual([{ name: "Paste into New Image", applied: true }]);
    expect(await doc.history.undo()).toBe(false);
  });
});

describe("Paste Selection (DOC-CLP-01h)", () => {
  it("combines the pasted outline with the selection and names the mode", async () => {
    const doc = Document.createBlank({ width: 6, height: 6 });
    doc.combineSelection([rectPolygon(rect(0, 0, 2, 2))], "replace");
    doc.pasteSelection([rectPolygon(rect(1, 1, 2, 2))], "union");
    expect(doc.selection.bounds()).toEqual(rect(0, 0, 3, 3));
    expect(doc.selection.area()).toBe(7);
    expect(doc.history.undoName).toBe("Paste Selection: Add (union)");

    doc.pasteSelection([rectPolygon(rect(4, 4, 1, 1))], "replace");
    expect(doc.selection.bounds()).toEqual(rect(4, 4, 1, 1));
    expect(doc.history.undoName).toBe("Paste Selection");
    expect(await doc.history.undo()).toBe(true);
    expect(doc.selection.bounds()).toEqual(rect(0, 0, 3, 3));
  });

  it("uses the names of the other modes", () => {
    const doc = Document.createBlank({ width: 6, height: 6 });
    doc.combineSelection([rectPolygon(rect(0, 0, 2, 2))], "replace");
    doc.pasteSelection([rectPolygon(rect(0, 0, 1, 1))], "exclude");
    expect(doc.history.undoName).toBe("Paste Selection: Subtract");
    doc.pasteSelection([rectPolygon(rect(0, 0, 1, 1))], "intersect");
    expect(doc.history.undoName).toBe("Paste Selection: Intersect");
    doc.pasteSelection([rectPolygon(rect(0, 0, 1, 1))], "xor");
    expect(doc.history.undoName).toBe('Paste Selection: Invert ("xor")');
  });
});

describe("clipboard error type", () => {
  it("carries the user-facing message id", () => {
    const error = new ClipboardError("clipboard.noImage");
    expect(error.message).toBe("The clipboard doesn't contain an image.");
    expect(error.messageId).toBe("clipboard.noImage");
  });
});
