// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Document, rect, Surface } from "@openpaint/document";
import { beforeAll, describe, expect, it } from "vitest";
import { cloneAnchorOf, readCloneSource, setCloneAnchor } from "./clone-source";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const RED = [255, 0, 0, 255];
const WHITE = [255, 255, 255, 255];

function paintPixel(doc: Document, x: number, y: number, color: number[]): void {
  const layer = doc.activeLayer;
  if (layer === undefined) throw new Error("no active layer");
  const surface = new Surface(1, 1);
  surface.setPixel(0, 0, {
    r: color[0] ?? 0,
    g: color[1] ?? 0,
    b: color[2] ?? 0,
    a: color[3] ?? 0,
  });
  doc.editLayerPixels("paint", layer, rect(x, y, 1, 1), (pixels) => {
    pixels.writeRegion(surface, x, y);
  });
}

describe("clone source (TL-BRUSH-CS-01)", () => {
  it("reads each destination pixel from the source point it is offset to", () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("no active layer");
    paintPixel(doc, 1, 1, RED);
    const source = { layer, offset: { x: -1, y: -1 }, snapshot: undefined };
    const out = readCloneSource(source, rect(2, 2, 2, 2));
    expect([...out.data.subarray(0, 4)]).toEqual(RED);
    expect([...out.data.subarray(4, 8)]).toEqual(WHITE);
  });

  it("reads transparent where the source point is off the layer", () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("no active layer");
    const source = { layer, offset: { x: -1, y: -1 }, snapshot: undefined };
    const out = readCloneSource(source, rect(0, 0, 2, 2));
    expect([...out.data.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    expect([...out.data.subarray(12, 16)]).toEqual(WHITE);
  });

  it("reads a snapshot taken before the stroke, not the layer as it is now", () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("no active layer");
    const snapshot = layer.pixels.readRegion(layer.pixels.bounds);
    paintPixel(doc, 1, 1, RED);
    const source = { layer, offset: { x: -1, y: -1 }, snapshot };
    const out = readCloneSource(source, rect(2, 2, 2, 2));
    expect([...out.data.subarray(0, 4)]).toEqual(WHITE);
  });

  it("keeps the anchor for its layer and drops it when that layer is removed", () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("no active layer");
    doc.addLayer();
    setCloneAnchor(doc, layer, 3, 4);
    expect(cloneAnchorOf(doc)).toMatchObject({ x: 3, y: 4, offset: undefined });
    doc.setActiveLayer(layer);
    doc.deleteActiveLayer();
    expect(cloneAnchorOf(doc)).toBeUndefined();
  });
});
