/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { LayerBlendMode } from "./blend-mode";
import { BLACK } from "./color";
import { Document } from "./document";
import { type Rect, rect } from "./geometry";
import type { Layer } from "./layer";
import { Surface } from "./surface";
import {
  documentThumbnail,
  layerThumbnail,
  ThumbnailAccumulator,
  ThumbnailRenderer,
  TiledThumbnail,
  thumbnailSize,
} from "./thumbnail";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

describe("thumbnailSize", () => {
  it("fits the longer side and keeps the aspect ratio", () => {
    expect(thumbnailSize(200, 100, 50)).toEqual({ width: 50, height: 25 });
    expect(thumbnailSize(100, 200, 50)).toEqual({ width: 25, height: 50 });
  });

  it("never upscales", () => {
    expect(thumbnailSize(10, 10, 50)).toEqual({ width: 10, height: 10 });
  });

  it("keeps at least one pixel on each side", () => {
    expect(thumbnailSize(1, 1000, 50)).toEqual({ width: 1, height: 50 });
  });

  it("rejects a size that is not a positive integer", () => {
    expect(() => thumbnailSize(10, 10, 0)).toThrow(RangeError);
    expect(() => thumbnailSize(10, 10, 2.5)).toThrow(RangeError);
  });
});

describe("ThumbnailAccumulator", () => {
  // Red and blue opaque, transparent, and white opaque: a 2x2 block that averages to one pixel.
  const block = () =>
    new Surface(
      2,
      2,
      new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255]),
    );

  it("averages color weighted by alpha and alpha over all pixels", () => {
    const accumulator = new ThumbnailAccumulator(2, 2, 1);
    accumulator.addBand(block(), 0);
    const thumb = accumulator.finish();
    expect(thumb.width).toBe(1);
    expect(thumb.height).toBe(1);
    // Premultiplied sums: red 255*255 + white 255*255 over alpha 765 gives 170; green and blue
    // follow the same way. Alpha is 765 / 4, rounded.
    expect([...thumb.data]).toEqual([170, 85, 170, 191]);
  });

  it("gives the same result whether the rows arrive in one band or two", () => {
    const whole = new ThumbnailAccumulator(2, 2, 1);
    whole.addBand(block(), 0);
    const split = new ThumbnailAccumulator(2, 2, 1);
    split.addBand(new Surface(2, 1, block().data.slice(0, 8)), 0);
    split.addBand(new Surface(2, 1, block().data.slice(8)), 1);
    expect([...split.finish().data]).toEqual([...whole.finish().data]);
  });

  it("keeps a fully transparent area transparent", () => {
    const accumulator = new ThumbnailAccumulator(2, 2, 1);
    accumulator.addBand(new Surface(2, 2), 0);
    expect([...accumulator.finish().data]).toEqual([0, 0, 0, 0]);
  });

  it("rejects bands that leave a gap or do not match the width", () => {
    const gap = new ThumbnailAccumulator(2, 2, 1);
    expect(() => gap.addBand(new Surface(2, 1), 1)).toThrow(RangeError);
    const wide = new ThumbnailAccumulator(2, 2, 1);
    expect(() => wide.addBand(new Surface(3, 1), 0)).toThrow(RangeError);
  });

  it("rejects a finish before every row arrived", () => {
    const accumulator = new ThumbnailAccumulator(2, 2, 1);
    accumulator.addBand(new Surface(2, 1), 0);
    expect(() => accumulator.finish()).toThrow(RangeError);
  });
});

describe("documentThumbnail", () => {
  it("shows the composited image at the requested size", () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    const thumb = documentThumbnail(doc, 4);
    expect(thumb.width).toBe(4);
    expect(thumb.height).toBe(4);
    expect([...thumb.data.slice(0, 4)]).toEqual([255, 255, 255, 255]);
    doc.dispose();
  });

  it("composites the layers above the background, left half black", () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    const top = doc.addLayer();
    doc.editLayerPixels("Paint", top, rect(0, 0, 4, 8), (pixels) => {
      pixels.fill(BLACK, rect(0, 0, 4, 8));
    });
    const thumb = documentThumbnail(doc, 8);
    expect([...thumb.data.slice(0, 4)]).toEqual([0, 0, 0, 255]);
    expect([...thumb.data.slice(7 * 4, 7 * 4 + 4)]).toEqual([255, 255, 255, 255]);
    doc.dispose();
  });

  it("ignores hidden layers", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    const top = doc.addLayer();
    doc.editLayerPixels("Paint", top, rect(0, 0, 4, 4), (pixels) => {
      pixels.fill(BLACK, rect(0, 0, 4, 4));
    });
    doc.setActiveLayerProperties({ visible: false });
    const thumb = documentThumbnail(doc, 4);
    expect([...thumb.data.slice(0, 4)]).toEqual([255, 255, 255, 255]);
    doc.dispose();
  });
});

describe("layerThumbnail", () => {
  it("shows the layer's own pixels, transparent where it is empty", () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    const top = doc.addLayer();
    doc.editLayerPixels("Paint", top, rect(0, 0, 4, 8), (pixels) => {
      pixels.fill(BLACK, rect(0, 0, 4, 8));
    });
    const thumb = layerThumbnail(top, 8);
    expect(thumb.width).toBe(8);
    expect([...thumb.data.slice(0, 4)]).toEqual([0, 0, 0, 255]);
    expect([...thumb.data.slice(7 * 4, 7 * 4 + 4)]).toEqual([0, 0, 0, 0]);
    doc.dispose();
  });

  it("ignores visibility and opacity, which apply only when compositing (DOC-LYR-01)", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    const top = doc.addLayer();
    doc.editLayerPixels("Paint", top, rect(0, 0, 4, 4), (pixels) => {
      pixels.fill(BLACK, rect(0, 0, 4, 4));
    });
    doc.setActiveLayerProperties({ visible: false, opacity: 0 });
    const thumb = layerThumbnail(top, 4);
    expect([...thumb.data.slice(0, 4)]).toEqual([0, 0, 0, 255]);
    doc.dispose();
  });
});

/** Deterministic noise with varied alpha, so every bin sums many different pixels. */
function noise(width: number, height: number, seed: number): Surface {
  const data = new Uint8ClampedArray(width * height * 4);
  let state = seed;
  for (let i = 0; i < data.length; i++) {
    state = (state * 1103515245 + 12345) >>> 0;
    data[i] = state >>> 24;
  }
  return new Surface(width, height, data);
}

function paint(doc: Document, layer: Layer, area: Rect, seed: number): void {
  doc.editLayerPixels("Paint", layer, area, (pixels) => {
    pixels.writeRegion(noise(area.width, area.height, seed), area.x, area.y);
  });
}

const pause = async () => {};

describe("ThumbnailRenderer (L8)", () => {
  // Not a multiple of the tile size, so edge tiles are partly outside the image.
  const WIDTH = 700;
  const HEIGHT = 530;

  function stackedDocument(): Document {
    const doc = Document.createBlank({ width: WIDTH, height: HEIGHT });
    const base = doc.activeLayer as Layer;
    paint(doc, base, rect(0, 0, WIDTH, HEIGHT), 1);
    const middle = doc.addLayer();
    paint(doc, middle, rect(100, 50, 400, 300), 2);
    doc.setActiveLayerProperties({ blendMode: LayerBlendMode.multiply, opacity: 180 });
    const top = doc.addLayer();
    paint(doc, top, rect(300, 200, 400, 330), 3);
    doc.setActiveLayerProperties({ blendMode: LayerBlendMode.difference });
    return doc;
  }

  it("gives exactly documentThumbnail and layerThumbnail", async () => {
    const doc = stackedDocument();
    const renderer = new ThumbnailRenderer(56);
    expect(await renderer.document(doc, pause)).toEqual(documentThumbnail(doc, 56));
    for (const layer of doc.layers) {
      expect(await renderer.layer(layer, pause)).toEqual(layerThumbnail(layer, 56));
    }
    doc.dispose();
  });

  it("follows edits, freed tiles, hidden layers and property changes", async () => {
    const doc = stackedDocument();
    const renderer = new ThumbnailRenderer(40);
    await renderer.document(doc, pause);
    const top = doc.activeLayer as Layer;
    paint(doc, top, rect(10, 10, 30, 30), 4);
    expect(await renderer.document(doc, pause)).toEqual(documentThumbnail(doc, 40));
    expect(await renderer.layer(top, pause)).toEqual(layerThumbnail(top, 40));
    doc.editLayerPixels("Clear", top, rect(256, 256, 256, 256), (pixels) => {
      pixels.clear(rect(256, 256, 256, 256));
    });
    expect(await renderer.document(doc, pause)).toEqual(documentThumbnail(doc, 40));
    expect(await renderer.layer(top, pause)).toEqual(layerThumbnail(top, 40));
    doc.setActiveLayerProperties({ visible: false });
    expect(await renderer.document(doc, pause)).toEqual(documentThumbnail(doc, 40));
    doc.setActiveLayerProperties({ visible: true, opacity: 90 });
    expect(await renderer.document(doc, pause)).toEqual(documentThumbnail(doc, 40));
    doc.dispose();
  });

  it("returns the same surface while nothing changed", async () => {
    const doc = stackedDocument();
    const renderer = new ThumbnailRenderer(40);
    const layer = doc.layers[0] as Layer;
    const first = await renderer.layer(layer, pause);
    expect(await renderer.layer(layer, pause)).toBe(first);
    const thumb = await renderer.document(doc, pause);
    expect(await renderer.document(doc, pause)).toBe(thumb);
    paint(doc, layer, rect(0, 0, 2, 2), 5);
    expect(await renderer.document(doc, pause)).not.toBe(thumb);
    doc.dispose();
  });
});

describe("TiledThumbnail", () => {
  it("reads only the tiles whose versions changed", async () => {
    const versions = new Map<string, number>();
    const sums = new TiledThumbnail(600, 600, 30);
    const read = vi.fn((area: Rect) => noise(area.width, area.height, area.x + area.y));
    const refresh = () => sums.refresh((tx, ty) => [versions.get(`${tx},${ty}`) ?? 0], read, pause);
    await refresh();
    expect(read).not.toHaveBeenCalled();
    versions.set("1,2", 7);
    versions.set("0,0", 3);
    await refresh();
    expect(read).toHaveBeenCalledTimes(2);
    await refresh();
    expect(read).toHaveBeenCalledTimes(2);
    versions.set("1,2", 8);
    await refresh();
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls.at(-1)?.[0]).toEqual(rect(256, 512, 256, 88));
  });

  it("pauses between batches of a large refresh", async () => {
    const sums = new TiledThumbnail(2048, 2048, 30);
    const pauses = vi.fn(async () => {});
    await sums.refresh(
      () => [1],
      (area) => new Surface(area.width, area.height),
      pauses,
    );
    // 64 tiles of 65536 pixels, four tiles per slice.
    expect(pauses).toHaveBeenCalledTimes(16);
  });
});
