// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import {
  Document,
  type Rect,
  rect,
  rectContainsRect,
  Selection,
  Surface,
  TiledPixelStore,
} from "@openpaint/document";
import { clipToCoverage } from "@openpaint/effects";
import { type BucketOptions, bucketFillCpu } from "@openpaint/engine";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type CoverageFill,
  hatchAligned,
  LayerSnapshot,
  renderCoverage,
  SessionPixels,
  TileRegion,
  writePatches,
} from "./layer-patch";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const WIDTH = 300;
const HEIGHT = 280;

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function noiseStore(seed: number): TiledPixelStore {
  const next = random(seed);
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(next() * 256);
  const store = new TiledPixelStore(WIDTH, HEIGHT);
  store.writeRegion(new Surface(WIDTH, HEIGHT, data), 0, 0);
  return store;
}

function randomFill(next: () => number, options: BucketOptions, count: number): CoverageFill {
  const parts = Array.from({ length: count }, () => {
    const x = Math.floor(next() * (WIDTH - 40));
    const y = Math.floor(next() * (HEIGHT - 40));
    const area = rect(x, y, 3 + Math.floor(next() * 37), 3 + Math.floor(next() * 37));
    const coverage = new Uint8Array(area.width * area.height);
    for (let i = 0; i < coverage.length; i++) {
      coverage[i] = next() < 0.3 ? 0 : Math.floor(next() * 256);
    }
    return { area, coverage };
  });
  return { parts, options };
}

/** The whole-layer render the tools did before (L2): full-size stencils, fills and clip. */
function wholeLayerRender(
  base: Surface,
  fills: readonly CoverageFill[],
  selection: Selection,
  pixelated: boolean,
): Surface {
  let filled = base;
  for (const fill of fills) {
    if (fill.parts.length === 0) continue;
    const mask = new Uint8Array(WIDTH * HEIGHT);
    for (const { area, coverage } of fill.parts) {
      for (let y = 0; y < area.height; y++) {
        for (let x = 0; x < area.width; x++) {
          const index = (area.y + y) * WIDTH + area.x + x;
          mask[index] = Math.max(mask[index] ?? 0, coverage[y * area.width + x] ?? 0);
        }
      }
    }
    filled = bucketFillCpu(filled, mask, fill.options);
  }
  if (selection.isEmpty) return filled;
  const raw = selection.mask(base.bounds);
  const coverage = pixelated ? raw.map((value) => (value >= 128 ? 255 : 0)) : raw;
  return clipToCoverage(base, filled, coverage);
}

function pixels(store: TiledPixelStore): number[] {
  return [...store.readRegion(store.bounds).data];
}

describe("renderCoverage (L2)", () => {
  const cases = [
    { seed: 1, hatch: 0, blend: 0, selection: undefined, pixelated: false },
    { seed: 2, hatch: 3, blend: 0, selection: undefined, pixelated: false },
    {
      seed: 3,
      hatch: 5,
      blend: 1,
      selection: [17.5, 9.25, 230.5, 12, 160, 250.75],
      pixelated: false,
    },
    { seed: 4, hatch: 8, blend: 14, selection: [3.5, 3.5, 290, 20, 280, 270], pixelated: true },
    {
      seed: 5,
      hatch: 1,
      blend: 8,
      selection: [100, 0, 300, 0, 300, 280, 100, 280],
      pixelated: false,
    },
  ];
  for (const kase of cases) {
    it(`equals the whole-layer render, case ${kase.seed}`, () => {
      const next = random(kase.seed * 97);
      const options = (color: number): BucketOptions => ({
        antialias: false,
        blend: kase.blend,
        hatch: kase.hatch,
        color: { r: color, g: 40, b: 200, a: 180 },
        background: { r: 10, g: color, b: 30, a: 90 },
      });
      const fills = [randomFill(next, options(250), 2), randomFill(next, options(20), 4)];
      const selection =
        kase.selection === undefined ? new Selection() : new Selection([kase.selection]);
      const layer = noiseStore(kase.seed);
      const before = layer.readRegion(layer.bounds);
      const expected = wholeLayerRender(before, fills, selection, kase.pixelated);

      const snapshot = new LayerSnapshot(layer);
      const { patches, box } = renderCoverage(snapshot, fills, {
        selection,
        pixelated: kase.pixelated,
      });
      for (const { area } of patches) {
        expect(area.x % 8).toBe(0);
        expect(area.y % 8).toBe(0);
        expect(Math.floor(area.x / 256)).toBe(Math.floor((area.x + area.width - 1) / 256));
        expect(rectContainsRect(hatchAligned(box, layer.bounds), area)).toBe(true);
      }
      writePatches(layer, patches);
      expect(pixels(layer)).toEqual([...expected.data]);
    });
  }

  it("skips the tiles inside an outline's box that no part reaches", () => {
    const layer = new TiledPixelStore(1024, 1024);
    const edge = (area: Rect) => ({
      area,
      coverage: new Uint8Array(area.width * area.height).fill(255),
    });
    const fills: CoverageFill[] = [
      {
        parts: [edge(rect(10, 10, 1000, 2)), edge(rect(10, 1000, 1000, 2))],
        options: {
          antialias: false,
          blend: 0,
          hatch: 0,
          color: { r: 0, g: 0, b: 0, a: 255 },
          background: { r: 0, g: 0, b: 0, a: 255 },
        },
      },
    ];
    const { patches, box } = renderCoverage(new LayerSnapshot(layer), fills, {
      selection: new Selection(),
      pixelated: false,
    });
    expect(box).toEqual(rect(10, 10, 1000, 992));
    expect(patches).toHaveLength(8);
    expect(patches.reduce((sum, { area }) => sum + area.width * area.height, 0)).toBeLessThan(
      2 * 1024 * 16,
    );
  });

  it("draws nothing for empty stencils", () => {
    const layer = noiseStore(9);
    const fills: CoverageFill[] = [
      {
        parts: [],
        options: {
          antialias: false,
          blend: 0,
          hatch: 0,
          color: { r: 0, g: 0, b: 0, a: 255 },
          background: { r: 0, g: 0, b: 0, a: 255 },
        },
      },
    ];
    const { patches, box } = renderCoverage(new LayerSnapshot(layer), fills, {
      selection: new Selection(),
      pixelated: false,
    });
    expect(patches).toEqual([]);
    expect(box.width).toBe(0);
  });
});

describe("TileRegion", () => {
  it("splits rectangles along the tile grid and joins them per tile", () => {
    const region = TileRegion.of(rect(250, 10, 20, 4), rect(0, 0, 4, 4));
    expect(region.rects()).toEqual(
      expect.arrayContaining([rect(0, 0, 250 + 6, 14), rect(256, 10, 14, 4)]),
    );
    expect(region.rects()).toHaveLength(2);
    expect(region.bounds()).toEqual(rect(0, 0, 270, 14));
    expect(new TileRegion().isEmpty).toBe(true);
    expect(region.union(TileRegion.of(rect(600, 600, 1, 1))).rects()).toHaveLength(3);
  });
});

describe("SessionPixels (L2)", () => {
  const red = { r: 255, g: 0, b: 0, a: 255 };
  const blue = { r: 0, g: 0, b: 255, a: 255 };
  const patchAt = (x: number, y: number, color = red) => {
    const output = new Surface(4, 4);
    output.fill(color);
    return { output, area: rect(x, y, 4, 4) };
  };

  const step = (session: object) => ({
    tool: "shapes",
    layer: 0,
    kind: "edit" as const,
    session,
    before: undefined,
    after: undefined,
  });
  const shownAt = (layer: { overlay?: { patches: readonly { area: Rect }[] } }) =>
    layer.overlay?.patches.map((patch) => patch.area) ?? [];

  it("shows each step over the layer and never writes the layer while pending", () => {
    const doc = Document.createBlank({ width: 2048, height: 512 });
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("no layer");
    const session = new SessionPixels(doc, layer);
    const base = layer.pixels.getPixel(1, 1);
    layer.pixels.clearDirty();
    session.show([patchAt(0, 0)]);
    session.show([patchAt(2000, 0)]);
    expect(layer.pixels.dirtyTiles()).toEqual([]);
    expect(shownAt(layer)).toEqual([patchAt(2000, 0).area]);
    expect(layer.pixels.getPixel(2001, 1)).toEqual(base);
    expect(doc.compositeArea(rect(2001, 1, 1, 1)).getPixel(0, 0)).toEqual(red);
    doc.dispose();
  });

  it("records steps as state only, reverts to the last one, and Finish writes it once", async () => {
    const doc = Document.createBlank({ width: 600, height: 300 });
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("no layer");
    const key = {};
    const session = new SessionPixels(doc, layer);
    const base = layer.pixels.getPixel(1, 1);
    session.show([patchAt(0, 0)]);
    expect(session.record("Draw", [patchAt(300, 0)], step(key))).toBe(true);
    expect(shownAt(layer)).toEqual([patchAt(300, 0).area]);
    session.show([patchAt(500, 0, blue)]);
    session.revert();
    expect(shownAt(layer)).toEqual([patchAt(300, 0).area]);
    expect(session.record("Edit", [patchAt(10, 10, blue)], step(key))).toBe(true);
    expect(layer.pixels.getPixel(11, 11)).toEqual(base);
    expect(
      session.finish("Finish", [patchAt(10, 10, blue)], { ...step(key), kind: "finish" }, () => [
        patchAt(10, 10, blue),
      ]),
    ).toBe(true);
    expect(layer.overlay).toBeUndefined();
    expect(layer.pixels.getPixel(11, 11)).toEqual(blue);
    await doc.history.undo();
    expect(layer.pixels.getPixel(11, 11)).toEqual(base);
    await doc.history.redo();
    expect(layer.pixels.getPixel(11, 11)).toEqual(blue);
    doc.dispose();
  });

  it("records nothing when no step drew a pixel", () => {
    const doc = Document.createBlank({ width: 64, height: 64 });
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("no layer");
    const before = doc.history.appliedCommands.length;
    expect(new SessionPixels(doc, layer).record("Draw", [], step({}))).toBe(false);
    expect(doc.history.appliedCommands).toHaveLength(before);
    doc.dispose();
  });
});
describe("hatchAligned", () => {
  it("moves the top-left corner onto the 8 px grid and clips to the bounds", () => {
    expect(hatchAligned(rect(13, 9, 10, 10), rect(0, 0, 100, 100))).toEqual(rect(8, 8, 15, 11));
    expect(hatchAligned(rect(-5, 3, 10, 10), rect(0, 0, 100, 100))).toEqual(rect(0, 0, 5, 13));
  });
});

describe("LayerSnapshot (L9)", () => {
  it("keeps the pixels a tile had when it was first read, and reads absent tiles as clear", () => {
    const store = new TiledPixelStore(600, 300);
    store.fill({ r: 9, g: 8, b: 7, a: 255 }, rect(0, 0, 256, 256));
    const snapshot = new LayerSnapshot(store);
    const area: Rect = rect(250, 10, 20, 4);
    const first = snapshot.read(area);
    store.fill({ r: 1, g: 1, b: 1, a: 255 }, rect(0, 0, 600, 300));
    expect(snapshot.read(area)).toEqual(first);
    expect(first.getPixel(0, 0)).toEqual({ r: 9, g: 8, b: 7, a: 255 });
    expect(first.getPixel(10, 0)).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    snapshot.restore(store, area);
    expect(store.getPixel(250, 10)).toEqual({ r: 9, g: 8, b: 7, a: 255 });
    expect(store.getPixel(262, 10)).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(store.getPixel(249, 10)).toEqual({ r: 1, g: 1, b: 1, a: 255 });
  });
});
