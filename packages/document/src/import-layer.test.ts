/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it } from "vitest";
import { type ColorRgba8, rgba8, WHITE } from "./color";
import { Document } from "./document";
import { Surface } from "./surface";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const RED = rgba8(255, 0, 0);

function red(width: number, height: number): Surface {
  const surface = new Surface(width, height);
  surface.fill(RED);
  return surface;
}

function pixelAt(doc: Document, layerIndex: number, x: number, y: number): ColorRgba8 {
  const layer = doc.layers[layerIndex];
  if (!layer) throw new Error(`missing layer ${layerIndex}`);
  return layer.pixels.getPixel(x, y);
}

describe("Import From File (DOC-LYR-05e)", () => {
  it("adds a named layer above the active layer, at the canvas origin", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });

    const layer = doc.importLayer("pic: Background", red(2, 2));

    expect(doc.layers.map((item) => item.name)).toEqual(["Background", "pic: Background"]);
    expect(doc.activeLayer).toBe(layer);
    expect(pixelAt(doc, 1, 1, 1)).toEqual(RED);
    expect(pixelAt(doc, 1, 2, 2).a).toBe(0);
    expect(doc.width).toBe(4);
  });

  it("clips an image larger than the canvas when the canvas is kept", () => {
    const doc = Document.createBlank({ width: 2, height: 2 });

    doc.importLayer("big", red(4, 4));

    expect(doc.width).toBe(2);
    expect(doc.height).toBe(2);
    expect(pixelAt(doc, 1, 1, 1)).toEqual(RED);
  });

  it("expands the canvas when asked, filling the old layers with transparency in one item", async () => {
    const doc = Document.createBlank({ width: 2, height: 2 });

    doc.importLayer("big", red(4, 3), { expandTo: { width: 4, height: 3 } });

    expect(doc.width).toBe(4);
    expect(doc.height).toBe(3);
    expect(pixelAt(doc, 0, 1, 1)).toEqual(WHITE);
    expect(pixelAt(doc, 0, 3, 2).a).toBe(0);
    expect(pixelAt(doc, 1, 3, 2)).toEqual(RED);
    expect(doc.history.undoName).toBe("Import From File");

    expect(await doc.history.undo()).toBe(true);
    expect(doc.width).toBe(2);
    expect(doc.height).toBe(2);
    expect(doc.layerCount).toBe(1);
  });

  it("refuses to shrink the canvas and changes nothing", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });

    expect(() => doc.importLayer("x", red(1, 1), { expandTo: { width: 2, height: 2 } })).toThrow(
      RangeError,
    );

    expect(doc.layerCount).toBe(1);
    expect(doc.width).toBe(4);
  });
});
