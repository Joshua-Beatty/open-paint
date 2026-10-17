/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { rect, rgba8, Surface, TiledPixelStore } from "@openpaint/document";
import { beforeAll, describe, expect, it } from "vitest";
import type { CompositeDocument } from "./composite";
import { initCpu, resampleLanczos3Rgba8 } from "./cpu";
import {
  boxHalve,
  coveredExtent,
  DISPLAY_TILE_SIZE,
  DisplayTileBuilder,
  DisplayTileCache,
  displayLevels,
  mipLevel,
  padTile,
  samplingFor,
  tileEdge,
  tilesAcross,
} from "./display-tiles";

function tile(level: number, tx: number, ty: number) {
  return { level, tx, ty, pixels: new Uint8Array(DISPLAY_TILE_SIZE * DISPLAY_TILE_SIZE * 4) };
}

function documentOf(store: TiledPixelStore): CompositeDocument {
  return {
    width: store.width,
    height: store.height,
    layers: [{ store, mode: 0, opacity: 255, visible: true }],
  };
}

const always = () => 0;

/** The 256 px premultiplied block of four cached level-0 tiles, as a level-1 build reads it. */
function blockOf(cache: DisplayTileCache, children: readonly [number, number][]): Uint8Array {
  const size = DISPLAY_TILE_SIZE;
  const block = new Uint8Array(size * 2 * size * 2 * 4);
  for (const [tx, ty] of children) {
    const pixels = cache.get(0, tx, ty)?.pixels;
    if (pixels === undefined) throw new Error(`No tile ${tx},${ty}.`);
    for (let y = 0; y < size; y++) {
      block.set(
        pixels.subarray(y * size * 4, (y + 1) * size * 4),
        ((ty * size + y) * size * 2 + tx * size) * 4,
      );
    }
  }
  return block;
}

describe("boxHalve", () => {
  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
  });

  it("averages each 2x2 group, rounded to nearest", () => {
    const block = new Uint8Array([10, 0, 0, 20, 11, 0, 0, 20, 12, 0, 0, 20, 13, 1, 0, 21]);
    expect([...boxHalve(block, 2)]).toEqual([12, 0, 0, 20]);
  });

  it("matches the 2x2 average at every pixel and channel of a tile block", () => {
    const edge = 256;
    const block = Uint8Array.from(
      { length: edge * edge * 4 },
      (_, i) => (i * 131 + (i >> 9)) & 255,
    );
    const out = boxHalve(block, edge);
    const half = edge / 2;
    let wrong = 0;
    for (let y = 0; y < half; y++) {
      for (let x = 0; x < half; x++) {
        for (let c = 0; c < 4; c++) {
          const at = (dx: number, dy: number) =>
            block[((y * 2 + dy) * edge + x * 2 + dx) * 4 + c] as number;
          const expected = (at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1) + 2) >> 2;
          if (out[(y * half + x) * 4 + c] !== expected) wrong++;
        }
      }
    }
    expect(wrong).toBe(0);
  });
});

describe("display tile grid (ARC-03-03/04)", () => {
  it("builds mip levels until the whole image fits in one tile", () => {
    expect(displayLevels(128, 128)).toBe(1);
    expect(displayLevels(129, 1)).toBe(2);
    expect(displayLevels(300, 200)).toBe(3);
    expect(displayLevels(8192, 8192)).toBe(7);
    expect(tileEdge(6)).toBe(128 * 64);
    expect(tilesAcross(8192, 6)).toBe(1);
    expect(tilesAcross(300, 0)).toBe(3);
  });

  it("selects floor(log2(1 / zoom)) clamped to the available levels", () => {
    expect(mipLevel(4, 7)).toBe(0);
    expect(mipLevel(1, 7)).toBe(0);
    expect(mipLevel(0.5, 7)).toBe(1);
    expect(mipLevel(0.3, 7)).toBe(1);
    expect(mipLevel(0.25, 7)).toBe(2);
    expect(mipLevel(1 / 100, 7)).toBe(6);
    expect(mipLevel(1 / 100, 3)).toBe(2);
  });

  it("samples nearest only at level 0 and zoom >= 100 %", () => {
    expect(samplingFor(0, 1)).toBe("nearest");
    expect(samplingFor(0, 2.5)).toBe("nearest");
    expect(samplingFor(0, 0.99)).toBe("bilinear");
    expect(samplingFor(1, 1)).toBe("bilinear");
  });
});

describe("DisplayTileCache", () => {
  it("evicts the least recently used tile first", () => {
    const cache = new DisplayTileCache(2);
    cache.put(tile(0, 0, 0));
    cache.put(tile(0, 1, 0));
    expect(cache.get(0, 0, 0)).toBeDefined();
    cache.put(tile(0, 2, 0));
    expect(cache.has({ level: 0, tx: 0, ty: 0 })).toBe(true);
    expect(cache.has({ level: 0, tx: 1, ty: 0 })).toBe(false);
    expect(cache.size).toBe(2);
  });

  it("marks stale the tiles whose document footprint overlaps an edit, at every level", () => {
    const cache = new DisplayTileCache();
    cache.put(tile(0, 0, 0));
    cache.put(tile(0, 1, 0));
    cache.put(tile(1, 0, 0));
    cache.put(tile(1, 1, 1));
    cache.invalidate(rect(200, 10, 10, 10));
    expect(cache.has({ level: 0, tx: 0, ty: 0 })).toBe(true);
    expect(cache.has({ level: 0, tx: 1, ty: 0 })).toBe(false);
    expect(cache.has({ level: 1, tx: 0, ty: 0 })).toBe(false);
    expect(cache.has({ level: 1, tx: 1, ty: 1 })).toBe(true);
    expect(cache.isStale(0, 1, 0)).toBe(true);
    expect(cache.isStale(1, 0, 0)).toBe(true);
    expect(cache.isStale(0, 0, 0)).toBe(false);
    expect(cache.isStale(3, 0, 0)).toBe(false);
    // A higher level is found by its footprint too, and an edit that ends at a tile's edge
    // leaves the next tile alone.
    cache.put(tile(3, 1, 0));
    cache.invalidate(rect(1024, 0, 1, 1));
    expect(cache.isStale(3, 1, 0)).toBe(true);
    cache.put(tile(0, 2, 0));
    cache.invalidate(rect(0, 0, 256, 1));
    expect(cache.isStale(0, 2, 0)).toBe(false);
  });

  it("keeps stale tiles displayable until a fresh tile replaces them", () => {
    const cache = new DisplayTileCache();
    const old = tile(0, 1, 0);
    cache.put(old);
    cache.invalidate(rect(200, 10, 10, 10));
    expect(cache.get(0, 1, 0)).toBe(old);
    const rebuilt = tile(0, 1, 0);
    cache.put(rebuilt);
    expect(cache.get(0, 1, 0)).toBe(rebuilt);
    expect(cache.has({ level: 0, tx: 1, ty: 0 })).toBe(true);
    expect(cache.isStale(0, 1, 0)).toBe(false);
  });
});

describe("DisplayTileBuilder", () => {
  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
  });

  it("renders level 0 as premultiplied composite pixels", () => {
    const store = new TiledPixelStore(256, 256);
    store.fill(rgba8(255, 0, 0, 128));
    const doc = documentOf(store);
    const cache = new DisplayTileCache();
    const builder = new DisplayTileBuilder(cache, () => doc);
    builder.request([{ level: 0, tx: 1, ty: 1 }]);
    expect(builder.pending).toBe(true);
    expect(builder.pump(1, always)).toBe(1);
    expect(builder.pending).toBe(false);
    const built = cache.get(0, 1, 1);
    expect([...(built?.pixels.subarray(0, 4) ?? [])]).toEqual([128, 0, 0, 128]);
  });

  it("stops when the deadline passes and resumes later", () => {
    const store = new TiledPixelStore(256, 256);
    const doc = documentOf(store);
    const cache = new DisplayTileCache();
    const builder = new DisplayTileBuilder(cache, () => doc);
    builder.request([
      { level: 0, tx: 0, ty: 0 },
      { level: 0, tx: 1, ty: 0 },
    ]);
    let clock = 0;
    const built = builder.pump(0.5, () => clock++ * 0.6);
    expect(built).toBe(1);
    expect(builder.pending).toBe(true);
    expect(builder.pump(100, always)).toBe(1);
    expect(builder.pending).toBe(false);
  });

  it("builds a higher level from its four children, which it builds first", () => {
    const store = new TiledPixelStore(256, 256);
    store.fill(rgba8(255, 0, 0, 255));
    const doc = documentOf(store);
    const cache = new DisplayTileCache();
    const builder = new DisplayTileBuilder(cache, () => doc);
    builder.request([{ level: 1, tx: 0, ty: 0 }]);
    builder.pump(1, always);
    expect(cache.has({ level: 0, tx: 0, ty: 0 })).toBe(true);
    expect(cache.has({ level: 0, tx: 1, ty: 1 })).toBe(true);
    const mip = cache.get(1, 0, 0);
    expect(mip?.pixels.length).toBe(DISPLAY_TILE_SIZE * DISPLAY_TILE_SIZE * 4);
    expect([...(mip?.pixels.subarray(0, 4) ?? [])]).toEqual([255, 0, 0, 255]);
    expect([...(mip?.pixels.subarray(-4) ?? [])]).toEqual([255, 0, 0, 255]);
  });

  it("drafts a mip tile under a live filter by sampling the layers at its level, then refines it", () => {
    const store = new TiledPixelStore(512, 512);
    for (let y = 0; y < 512; y += 2) {
      for (let x = 0; x < 512; x += 2) {
        // Each 2 x 2 block's sampled pixel (its bottom-right one) is red, the others blue.
        store.fill(rgba8(0, 0, 255, 255), rect(x, y, 2, 2));
        store.setPixel(x + 1, y + 1, rgba8(255, 0, 0, 255));
      }
    }
    const live = {
      effectId: "invertColors-not-per-pixel",
      params: {},
      region: rect(0, 0, 512, 512),
      coverage: undefined,
      key: "none",
    };
    const sepia = { ...live, effectId: "sepia", params: { intensity: 0 }, key: "sepia" };
    const cache = new DisplayTileCache();
    let doc: CompositeDocument = {
      width: 512,
      height: 512,
      layers: [{ store, mode: 0, opacity: 255, visible: true, live: sepia }],
    };
    const builder = new DisplayTileBuilder(cache, () => doc);
    builder.request([{ level: 1, tx: 0, ty: 0 }]);
    expect(builder.pump(1, always)).toBe(1);
    // No level-0 tile was built: the draft sampled the store directly, through the filter.
    expect(cache.has({ level: 0, tx: 0, ty: 0 })).toBe(false);
    expect(cache.isDraft({ level: 1, tx: 0, ty: 0 })).toBe(true);
    const [r = 0, g = 0, b = 0] = cache.get(1, 0, 0)?.pixels ?? [];
    // Sepia at intensity 0 makes red gray, the luma of pure red.
    expect(r).toBe(g);
    expect(g).toBe(b);
    expect(r).toBeGreaterThan(40);
    expect(r).toBeLessThan(100);

    // A filter the canvas cannot apply leaves the sampled pixels as they are.
    doc = { ...doc, layers: [{ store, mode: 0, opacity: 255, visible: true, live }] };
    cache.invalidate(rect(0, 0, 512, 512));
    builder.request([{ level: 1, tx: 0, ty: 0 }]);
    builder.pump(1, always);
    expect([...(cache.get(1, 0, 0)?.pixels.subarray(0, 4) ?? [])]).toEqual([255, 0, 0, 255]);

    // Once refined, the tile is built from its children like any other.
    builder.request([], [{ level: 1, tx: 0, ty: 0 }]);
    builder.pump(1, always);
    expect(cache.hasFinal({ level: 1, tx: 0, ty: 0 })).toBe(true);
    expect(cache.has({ level: 0, tx: 0, ty: 0 })).toBe(true);
  });

  it("repeats the image's edge beyond it, so the edge stays opaque at every level (UI-VIEW-02)", () => {
    // 201 x 101: level 1 covers 100.5 x 50.5 pixels, so its column 100 and row 50 are partly
    // transparent before padding, and the rest of the tile lies beyond the image.
    const store = new TiledPixelStore(201, 101);
    store.fill(rgba8(0, 0, 255, 255));
    const doc = documentOf(store);
    const cache = new DisplayTileCache();
    const builder = new DisplayTileBuilder(cache, () => doc);
    const ref = { level: 1, tx: 0, ty: 0 };
    const at = (x: number, y: number) => {
      const i = (y * DISPLAY_TILE_SIZE + x) * 4;
      return [...(cache.get(1, 0, 0)?.pixels.subarray(i, i + 4) ?? [])];
    };
    builder.request([ref]);
    builder.pump(1, always);
    for (const [x, y] of [
      [0, 0],
      [99, 49],
      [100, 50],
      [127, 0],
      [0, 127],
      [127, 127],
    ] as const) {
      expect(at(x, y)).toEqual([0, 0, 255, 255]);
    }
    // The final Lanczos-3 build reaches 3 pixels past the edge, which the padding also covers.
    builder.request([ref], [ref]);
    builder.pump(1, always);
    expect(cache.hasFinal(ref)).toBe(true);
    expect(at(100, 50)).toEqual([0, 0, 255, 255]);
    expect(at(99, 25)).toEqual([0, 0, 255, 255]);
  });

  it("pads a tile with copies of its last covered column and row", () => {
    // A 4 x 4 tile whose top-left 2 x 3 pixels hold the image, numbered by position.
    const pixels = new Uint8Array(4 * 4 * 4);
    for (let y = 0; y < 3; y++)
      for (let x = 0; x < 2; x++) pixels.fill(y * 10 + x + 1, (y * 4 + x) * 4, (y * 4 + x) * 4 + 4);
    padTile(pixels, 4, 2, 3);
    const row = (y: number) => [0, 1, 2, 3].map((x) => pixels[(y * 4 + x) * 4]);
    expect(row(0)).toEqual([1, 2, 2, 2]);
    expect(row(2)).toEqual([21, 22, 22, 22]);
    expect(row(3)).toEqual([21, 22, 22, 22]);
    expect(coveredExtent(201, 1)).toBe(100);
    expect(coveredExtent(1, 3)).toBe(1);
  });

  it("rebuilds stale tiles from the current document", () => {
    const store = new TiledPixelStore(256, 256);
    store.fill(rgba8(255, 0, 0, 255));
    const doc = documentOf(store);
    const cache = new DisplayTileCache();
    const builder = new DisplayTileBuilder(cache, () => doc);
    builder.request([{ level: 0, tx: 0, ty: 0 }]);
    builder.pump(1, always);
    store.fill(rgba8(0, 0, 255, 255));
    cache.invalidate(rect(0, 0, 10, 10));
    builder.request([{ level: 0, tx: 0, ty: 0 }]);
    expect(builder.pending).toBe(true);
    builder.pump(1, always);
    expect([...(cache.get(0, 0, 0)?.pixels.subarray(0, 4) ?? [])]).toEqual([0, 0, 255, 255]);
    expect(cache.isStale(0, 0, 0)).toBe(false);
  });

  it("builds mip tiles as box-filtered drafts, then refines them with Lanczos-3 (ARC-03-04)", () => {
    const store = new TiledPixelStore(512, 512);
    // A one-pixel checker, which the box filter and Lanczos-3 halve differently at level 2.
    const data = new Uint8ClampedArray(512 * 512 * 4);
    for (let i = 0; i < 512 * 512; i++) {
      const on = ((i % 512) + Math.floor(i / 512)) % 2 === 0;
      data.set(on ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4);
    }
    store.writeRegion(new Surface(512, 512, data), 0, 0);
    const doc = documentOf(store);
    const reference = new DisplayTileCache();
    const finalBuilder = new DisplayTileBuilder(reference, () => doc);
    const cache = new DisplayTileCache();
    const builder = new DisplayTileBuilder(cache, () => doc);
    const top = { level: 2, tx: 0, ty: 0 };

    builder.request([top]);
    builder.pump(1, always);
    expect(cache.isDraft(top)).toBe(true);
    expect(cache.isDraft({ level: 1, tx: 1, ty: 1 })).toBe(true);
    expect(cache.hasFinal({ level: 0, tx: 3, ty: 3 })).toBe(true);
    expect([...(cache.get(2, 0, 0)?.pixels.subarray(0, 4) ?? [])]).toEqual([128, 128, 128, 255]);

    // Nothing is missing, so the refine list queues the draft and its draft children.
    builder.request([top], [top]);
    expect(builder.pending).toBe(true);
    builder.pump(1, always);
    expect(cache.hasFinal(top)).toBe(true);
    expect(cache.hasFinal({ level: 1, tx: 1, ty: 1 })).toBe(true);

    finalBuilder.request([top], [top]);
    finalBuilder.pump(1, always);
    finalBuilder.request([top], [top]);
    finalBuilder.pump(1, always);
    expect(cache.get(2, 0, 0)?.pixels).toEqual(reference.get(2, 0, 0)?.pixels);
    const level1 = cache.get(1, 0, 0)?.pixels;
    const lanczos = resampleLanczos3Rgba8(
      blockOf(cache, [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ]),
      256,
      256,
      128,
      128,
    );
    expect(level1).toEqual(lanczos);
  });

  it("does not refine while tiles are missing, and refines nothing that is final", () => {
    const doc = documentOf(new TiledPixelStore(256, 256));
    const cache = new DisplayTileCache();
    const builder = new DisplayTileBuilder(cache, () => doc);
    builder.request([{ level: 0, tx: 0, ty: 0 }], [{ level: 0, tx: 0, ty: 0 }]);
    builder.pump(1, always);
    builder.request([], [{ level: 0, tx: 0, ty: 0 }]);
    expect(builder.pending).toBe(false);
  });

  it("does not request tiles that are already cached", () => {
    const doc = documentOf(new TiledPixelStore(256, 256));
    const cache = new DisplayTileCache();
    const builder = new DisplayTileBuilder(cache, () => doc);
    builder.request([{ level: 0, tx: 0, ty: 0 }]);
    builder.pump(1, always);
    builder.request([{ level: 0, tx: 0, ty: 0 }]);
    expect(builder.pending).toBe(false);
  });
});

describe("DisplayTileBuilder.final", () => {
  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
  });

  it("builds the same final tile as the refined builds, from an empty cache", () => {
    const store = new TiledPixelStore(700, 300);
    const noise = new Surface(700, 300);
    for (let i = 0; i < noise.data.length; i++) noise.data[i] = (i * 2654435761) >>> 24;
    store.writeRegion(noise, 0, 0);
    const doc = documentOf(store);
    const pumped = new DisplayTileBuilder(new DisplayTileCache(), () => doc);
    const ref = { level: 2, tx: 1, ty: 0 };
    pumped.request([ref]);
    pumped.pump(Number.POSITIVE_INFINITY, always);
    pumped.request([], [ref]);
    pumped.pump(Number.POSITIVE_INFINITY, always);
    expect(pumped.cache.hasFinal(ref)).toBe(true);
    const direct = new DisplayTileBuilder(new DisplayTileCache(), () => doc);
    const built = direct.final(ref);
    expect(direct.cache.hasFinal(ref)).toBe(true);
    expect([...built.pixels]).toEqual([...(pumped.cache.get(2, 1, 0)?.pixels ?? [])]);
    // A second call takes it from the cache.
    expect(direct.final(ref)).toBe(built);
  });
});
