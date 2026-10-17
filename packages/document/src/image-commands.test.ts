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
import { rectPolygon } from "./selection-polygons";
import { Surface } from "./surface";
import { TILE_BYTES } from "./tiled-store";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const RED = rgba8(255, 0, 0);
const BLUE = rgba8(0, 0, 255);
const NEAREST = { filter: "nearest", linearLight: false } as const;

/** A colour that depends on the position, so a misplaced pixel is visible. */
function patternColor(x: number, y: number): ColorRgba8 {
  return rgba8(x & 255, y & 255, 7);
}

function patternSurface(width: number, height: number): Surface {
  const surface = new Surface(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) surface.setPixel(x, y, patternColor(x, y));
  }
  return surface;
}

function layerAt(doc: Document, index: number): Layer {
  const layer = doc.layers[index];
  if (!layer) throw new Error(`missing layer ${index}`);
  return layer;
}

/** Counts the pixels of `layer` that differ from `expected` over a `width` x `height` canvas. */
function mismatches(
  layer: Layer,
  width: number,
  height: number,
  expected: (x: number, y: number) => ColorRgba8,
): number {
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const actual = layer.pixels.getPixel(x, y);
      const want = expected(x, y);
      if (
        actual.r !== want.r ||
        actual.g !== want.g ||
        actual.b !== want.b ||
        actual.a !== want.a
      ) {
        count++;
      }
    }
  }
  return count;
}

describe("Resize (DOC-IMG-02)", () => {
  it("resamples every layer to the new size and records one Resize item", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.addLayer();
    expect(doc.resize({ width: 8, height: 2 }, NEAREST)).toBe(true);
    expect(doc.width).toBe(8);
    expect(doc.height).toBe(2);
    for (const layer of doc.layers) {
      expect(layer.pixels.width).toBe(8);
      expect(layer.pixels.height).toBe(2);
    }
    expect(layerAt(doc, 0).pixels.getPixel(7, 1)).toEqual(WHITE);
    expect(doc.history.undoName).toBe("Resize");
    expect(doc.dirty).toBe(true);
  });

  it("uses the chosen filter: nearest keeps hard edges exact", () => {
    const doc = Document.createBlank({ width: 2, height: 2 });
    const background = layerAt(doc, 0);
    background.pixels.setPixel(0, 0, RED);
    doc.resize({ width: 4, height: 4 }, NEAREST);
    expect(mismatches(background, 4, 4, (x, y) => (x < 2 && y < 2 ? RED : WHITE))).toBe(0);
  });

  it("keeps transparent layers transparent", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    const top = doc.addLayer();
    doc.resize({ width: 8, height: 8 }, NEAREST);
    expect(top.pixels.getPixel(3, 5).a).toBe(0);
  });

  it("clears the selection", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.selectAll();
    doc.resize({ width: 2, height: 2 }, NEAREST);
    expect(doc.selection.isEmpty).toBe(true);
  });

  it("changes only the resolution when the pixel size is unchanged", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    const background = layerAt(doc, 0);
    background.pixels.setPixel(1, 1, RED);
    const entries = doc.history.entries.length;
    expect(doc.resize({ width: 4, height: 4 }, NEAREST, { unit: "inch", x: 300, y: 300 })).toBe(
      true,
    );
    expect(doc.resolution).toEqual({ unit: "inch", x: 300, y: 300 });
    expect(background.pixels.getPixel(1, 1)).toEqual(RED);
    expect(doc.history.entries.length).toBe(entries + 1);
    expect(doc.history.undoName).toBe("Resize");
  });

  it("does nothing when neither the size nor the resolution changes", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.markClean();
    expect(doc.resize({ width: 4, height: 4 }, NEAREST)).toBe(false);
    expect(doc.history.entries.length).toBe(1);
    expect(doc.dirty).toBe(false);
  });

  it("rejects sizes outside the document limits", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    expect(() => doc.resize({ width: 0, height: 4 }, NEAREST)).toThrow(RangeError);
    expect(doc.width).toBe(4);
  });

  it("restores the size, pixels and selection on undo and reapplies them on redo", async () => {
    const doc = Document.createBlank({ width: 2, height: 2 });
    doc.selectAll();
    doc.resize({ width: 4, height: 4 }, NEAREST);

    expect(await doc.history.undo()).toBe(true);
    expect(doc.width).toBe(2);
    expect(layerAt(doc, 0).pixels.width).toBe(2);
    expect(doc.selection.bounds()).toEqual(rect(0, 0, 2, 2));

    expect(await doc.history.redo()).toBe(true);
    expect(doc.width).toBe(4);
    expect(layerAt(doc, 0).pixels.width).toBe(4);
    expect(doc.selection.isEmpty).toBe(true);
  });

  it("leaves the document unchanged when the new pixels cannot be allocated", () => {
    const accountant = new MemoryAccountant(TILE_BYTES);
    const doc = Document.createBlank({ width: 16, height: 16, accountant });
    const entries = doc.history.entries.length;
    expect(() => doc.resize({ width: 300, height: 300 }, NEAREST)).toThrow(OutOfMemoryError);
    expect(doc.width).toBe(16);
    expect(layerAt(doc, 0).pixels.width).toBe(16);
    expect(doc.history.entries.length).toBe(entries);
  });
});

describe("Canvas Size (DOC-IMG-03)", () => {
  it("places the pixels by the anchor and fills the new area of every layer", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    const top = doc.addLayer();
    top.pixels.setPixel(0, 0, BLUE);
    doc.resizeCanvas({ width: 6, height: 5 }, "topLeft", RED);
    const background = layerAt(doc, 0);
    expect(background.pixels.getPixel(0, 0)).toEqual(WHITE);
    expect(background.pixels.getPixel(5, 4)).toEqual(RED);
    expect(background.pixels.getPixel(3, 3)).toEqual(WHITE);
    expect(top.pixels.getPixel(0, 0)).toEqual(BLUE);
    expect(top.pixels.getPixel(5, 4)).toEqual(RED);
    expect(doc.history.undoName).toBe("Canvas Size");
  });

  it("centres the old pixels with the center anchor", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.resizeCanvas({ width: 6, height: 4 }, "center", RED);
    const background = layerAt(doc, 0);
    expect(background.pixels.getPixel(0, 0)).toEqual(RED);
    expect(background.pixels.getPixel(1, 0)).toEqual(WHITE);
    expect(background.pixels.getPixel(4, 3)).toEqual(WHITE);
    expect(background.pixels.getPixel(5, 3)).toEqual(RED);
  });

  it("fills with transparency when asked", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.resizeCanvas({ width: 6, height: 6 }, "topLeft", TRANSPARENT);
    const background = layerAt(doc, 0);
    expect(background.pixels.getPixel(0, 0)).toEqual(WHITE);
    expect(background.pixels.getPixel(5, 5)).toEqual(TRANSPARENT);
  });

  it("crops the pixels that fall outside a smaller canvas", () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    const background = layerAt(doc, 0);
    background.pixels.writeRegion(patternSurface(8, 8), 0, 0);
    doc.resizeCanvas({ width: 4, height: 4 }, "bottomRight", TRANSPARENT);
    expect(mismatches(background, 4, 4, (x, y) => patternColor(x + 4, y + 4))).toBe(0);
  });

  it("uses negative offsets for a centred shrink, rounding halves toward zero", () => {
    const doc = Document.createBlank({ width: 8, height: 2 });
    const background = layerAt(doc, 0);
    background.pixels.writeRegion(patternSurface(8, 2), 0, 0);
    doc.resizeCanvas({ width: 5, height: 2 }, "center", TRANSPARENT);
    expect(mismatches(background, 5, 2, (x, y) => patternColor(x + 1, y))).toBe(0);
  });

  it("moves the selection with the pixels", () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    doc.combineSelection([rectPolygon(rect(0, 0, 2, 2))], "replace");
    doc.resizeCanvas({ width: 10, height: 10 }, "bottomRight", TRANSPARENT);
    expect(doc.selection.bounds()).toEqual(rect(2, 2, 2, 2));
  });

  it("changes only the resolution when the size is unchanged", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    expect(
      doc.resizeCanvas({ width: 4, height: 4 }, "center", RED, { unit: "pixel", x: 1, y: 1 }),
    ).toBe(true);
    expect(layerAt(doc, 0).pixels.getPixel(0, 0)).toEqual(WHITE);
    expect(doc.history.undoName).toBe("Resize");
  });

  it("restores the size and pixels on undo", async () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.resizeCanvas({ width: 6, height: 6 }, "topLeft", RED);
    expect(await doc.history.undo()).toBe(true);
    expect(doc.width).toBe(4);
    expect(layerAt(doc, 0).pixels.width).toBe(4);
    expect(layerAt(doc, 0).pixels.getPixel(3, 3)).toEqual(WHITE);
  });
});

describe("Flip Horizontal and Flip Vertical (DOC-IMG-04/05)", () => {
  it("mirrors every layer across the width, across a tile edge", () => {
    const doc = Document.createBlank({ width: 300, height: 2 });
    const background = layerAt(doc, 0);
    background.pixels.writeRegion(patternSurface(300, 2), 0, 0);
    doc.flipImage("horizontal");
    expect(mismatches(background, 300, 2, (x, y) => patternColor(299 - x, y))).toBe(0);
    expect(doc.history.undoName).toBe("Flip Horizontal (all)");
  });

  it("mirrors every layer across the height", () => {
    const doc = Document.createBlank({ width: 4, height: 6 });
    const top = doc.addLayer();
    top.pixels.setPixel(0, 0, RED);
    const background = layerAt(doc, 0);
    background.pixels.writeRegion(patternSurface(4, 6), 0, 0);
    doc.flipImage("vertical");
    expect(mismatches(background, 4, 6, (x, y) => patternColor(x, 5 - y))).toBe(0);
    expect(top.pixels.getPixel(0, 5)).toEqual(RED);
    expect(doc.history.undoName).toBe("Flip Vertical (all)");
  });

  it("mirrors the selection with the image", () => {
    const doc = Document.createBlank({ width: 8, height: 6 });
    doc.combineSelection([rectPolygon(rect(0, 0, 2, 3))], "replace");
    doc.flipImage("horizontal");
    expect(doc.selection.bounds()).toEqual(rect(6, 0, 2, 3));
    doc.flipImage("vertical");
    expect(doc.selection.bounds()).toEqual(rect(6, 3, 2, 3));
  });

  it("restores the pixels and selection on undo", async () => {
    const doc = Document.createBlank({ width: 8, height: 6 });
    doc.combineSelection([rectPolygon(rect(0, 0, 2, 3))], "replace");
    layerAt(doc, 0).pixels.setPixel(0, 0, RED);
    doc.flipImage("horizontal");
    expect(await doc.history.undo()).toBe(true);
    expect(layerAt(doc, 0).pixels.getPixel(0, 0)).toEqual(RED);
    expect(doc.selection.bounds()).toEqual(rect(0, 0, 2, 3));
  });
});

describe("Rotate (DOC-IMG-06/07/08)", () => {
  const WIDTH = 300;
  const HEIGHT = 200;

  function patternDocument(): { doc: Document; background: Layer } {
    const doc = Document.createBlank({ width: WIDTH, height: HEIGHT });
    const background = layerAt(doc, 0);
    background.pixels.writeRegion(patternSurface(WIDTH, HEIGHT), 0, 0);
    return { doc, background };
  }

  it("rotates 90° clockwise: width and height swap and each pixel moves to (H-1-y, x)", () => {
    const { doc, background } = patternDocument();
    doc.rotateImage("cw");
    expect(doc.width).toBe(HEIGHT);
    expect(doc.height).toBe(WIDTH);
    expect(background.pixels.width).toBe(HEIGHT);
    expect(background.pixels.height).toBe(WIDTH);
    expect(mismatches(background, HEIGHT, WIDTH, (x, y) => patternColor(y, HEIGHT - 1 - x))).toBe(
      0,
    );
    expect(doc.history.undoName).toBe("Rotate 90° CW");
  });

  it("rotates 90° counter-clockwise: each pixel moves to (y, W-1-x)", () => {
    const { doc, background } = patternDocument();
    doc.rotateImage("ccw");
    expect(doc.width).toBe(HEIGHT);
    expect(doc.height).toBe(WIDTH);
    expect(mismatches(background, HEIGHT, WIDTH, (x, y) => patternColor(WIDTH - 1 - y, x))).toBe(0);
    expect(doc.history.undoName).toBe("Rotate 90° CCW");
  });

  it("rotates 180°: each pixel moves to (W-1-x, H-1-y)", () => {
    const { doc, background } = patternDocument();
    doc.rotateImage("half");
    expect(doc.width).toBe(WIDTH);
    expect(doc.height).toBe(HEIGHT);
    expect(
      mismatches(background, WIDTH, HEIGHT, (x, y) => patternColor(WIDTH - 1 - x, HEIGHT - 1 - y)),
    ).toBe(0);
    expect(doc.history.undoName).toBe("Rotate 180° (all)");
  });

  it("rotates every layer, including hidden ones", () => {
    const doc = Document.createBlank({ width: 300, height: 200 });
    const top = doc.addLayer();
    top.pixels.setPixel(10, 20, RED);
    doc.setActiveLayerProperties({ visible: false });
    doc.rotateImage("cw");
    expect(top.pixels.getPixel(200 - 1 - 20, 10)).toEqual(RED);
  });

  it("rotates the selection with the image", () => {
    const doc = Document.createBlank({ width: 300, height: 200 });
    doc.combineSelection([rectPolygon(rect(0, 0, 10, 20))], "replace");
    doc.rotateImage("cw");
    expect(doc.selection.bounds()).toEqual(rect(180, 0, 20, 10));

    const ccw = Document.createBlank({ width: 300, height: 200 });
    ccw.combineSelection([rectPolygon(rect(0, 0, 10, 20))], "replace");
    ccw.rotateImage("ccw");
    expect(ccw.selection.bounds()).toEqual(rect(0, 290, 20, 10));

    const half = Document.createBlank({ width: 300, height: 200 });
    half.combineSelection([rectPolygon(rect(0, 0, 10, 20))], "replace");
    half.rotateImage("half");
    expect(half.selection.bounds()).toEqual(rect(290, 180, 10, 20));
  });

  it("restores the size and pixels on undo and reapplies them on redo", async () => {
    const { doc, background } = patternDocument();
    doc.rotateImage("cw");
    expect(await doc.history.undo()).toBe(true);
    expect(doc.width).toBe(WIDTH);
    expect(doc.height).toBe(HEIGHT);
    expect(mismatches(background, WIDTH, HEIGHT, patternColor)).toBe(0);

    expect(await doc.history.redo()).toBe(true);
    expect(doc.width).toBe(HEIGHT);
    expect(background.pixels.width).toBe(HEIGHT);
  });
});

describe("Flatten (DOC-IMG-09)", () => {
  it("composites the visible layers into one Background layer and clears the selection", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    const top = doc.addLayer();
    top.pixels.fill(RED);
    doc.setActiveLayerProperties({ opacity: 128 });
    doc.selectAll();

    expect(doc.flatten()).toBe(true);
    expect(doc.layerCount).toBe(1);
    const merged = layerAt(doc, 0);
    expect(merged.name).toBe("Background");
    expect(merged.isBackground).toBe(true);
    expect(merged.opacity).toBe(255);
    const centre = merged.pixels.getPixel(1, 1);
    expect(centre.r).toBe(255);
    expect(centre.g).toBeGreaterThan(120);
    expect(centre.g).toBeLessThan(135);
    expect(centre.a).toBe(255);
    expect(doc.selection.isEmpty).toBe(true);
    expect(doc.activeLayer).toBe(merged);
    expect(doc.history.undoName).toBe("Flatten");
  });

  it("discards hidden layers", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    const top = doc.addLayer();
    top.pixels.fill(RED);
    doc.setActiveLayerProperties({ visible: false });
    doc.flatten();
    expect(layerAt(doc, 0).pixels.getPixel(2, 2)).toEqual(WHITE);
  });

  it("copies the metadata of the bottom layer", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.addLayer();
    layerAt(doc, 0).metadata.set("note", "kept");
    doc.flatten();
    expect(layerAt(doc, 0).metadata.get("note")).toBe("kept");
  });

  it("does nothing with a single layer", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.markClean();
    expect(doc.flatten()).toBe(false);
    expect(doc.history.entries.length).toBe(1);
    expect(doc.dirty).toBe(false);
  });

  it("restores every layer, the active layer and the selection on undo", async () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    const top = doc.addLayer();
    top.pixels.fill(RED);
    doc.combineSelection([rectPolygon(rect(0, 0, 2, 2))], "replace");
    doc.flatten();

    expect(await doc.history.undo()).toBe(true);
    expect(doc.layerCount).toBe(2);
    expect(doc.layers[1]).toBe(top);
    expect(top.pixels.getPixel(0, 0)).toEqual(RED);
    expect(doc.activeLayer).toBe(top);
    expect(doc.selection.bounds()).toEqual(rect(0, 0, 2, 2));

    expect(await doc.history.redo()).toBe(true);
    expect(doc.layerCount).toBe(1);
    expect(layerAt(doc, 0).pixels.getPixel(0, 0)).toEqual(RED);
  });
});
