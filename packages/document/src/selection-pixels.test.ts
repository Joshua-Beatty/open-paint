/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it } from "vitest";
import { rgba8, TRANSPARENT, WHITE } from "./color";
import { rect } from "./geometry";
import { Selection } from "./selection";
import { clipAlphaToCoverage, overwriteSelection } from "./selection-pixels";
import { rectPolygon } from "./selection-polygons";
import { Surface } from "./surface";
import { TiledPixelStore } from "./tiled-store";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const RED = rgba8(255, 0, 0);

describe("overwriteSelection (DOC-SEL-06d/e)", () => {
  it("covers the whole area when the selection is empty", () => {
    const store = new TiledPixelStore(4, 4);
    store.fill(WHITE);
    overwriteSelection(store, rect(0, 0, 4, 4), new Selection(), RED);
    expect(store.getPixel(0, 0)).toEqual(RED);
    expect(store.getPixel(3, 3)).toEqual(RED);
  });

  it("replaces only the pixels inside an aliased selection", () => {
    const store = new TiledPixelStore(4, 4);
    store.fill(WHITE);
    const selection = new Selection([rectPolygon(rect(1, 1, 2, 2))], "aliased");
    overwriteSelection(store, rect(0, 0, 4, 4), selection, RED);
    expect(store.getPixel(1, 1)).toEqual(RED);
    expect(store.getPixel(2, 2)).toEqual(RED);
    expect(store.getPixel(0, 0)).toEqual(WHITE);
    expect(store.getPixel(3, 3)).toEqual(WHITE);
  });

  it("writes the color exactly over the destination instead of compositing", () => {
    const store = new TiledPixelStore(2, 2);
    store.fill(rgba8(0, 0, 255, 255));
    overwriteSelection(store, rect(0, 0, 2, 2), new Selection(), rgba8(10, 20, 30, 40));
    expect(store.getPixel(0, 0)).toEqual(rgba8(10, 20, 30, 40));
  });

  it("weights by coverage, so partly covered pixels blend", () => {
    const store = new TiledPixelStore(4, 4);
    store.fill(WHITE);
    const selection = new Selection([[0, 0, 2, 0, 0, 2]], "antialiased");
    overwriteSelection(store, rect(0, 0, 4, 4), selection, rgba8(0, 0, 0, 0));
    expect(store.getPixel(0, 0).a).toBe(0);
    const edge = store.getPixel(1, 0).a;
    expect(edge).toBeGreaterThan(100);
    expect(edge).toBeLessThan(160);
    expect(store.getPixel(3, 3)).toEqual(WHITE);
  });

  it("clears without allocating tiles that were already transparent", () => {
    const store = new TiledPixelStore(512, 512);
    const selection = new Selection([rectPolygon(rect(0, 0, 400, 400))], "aliased");
    overwriteSelection(store, rect(0, 0, 512, 512), selection, TRANSPARENT);
    expect(store.allocatedTileCount).toBe(0);
  });

  it("does not touch pixels outside the area", () => {
    const store = new TiledPixelStore(4, 4);
    store.fill(WHITE);
    overwriteSelection(
      store,
      rect(0, 0, 2, 2),
      new Selection([rectPolygon(rect(0, 0, 4, 4))], "aliased"),
      RED,
    );
    expect(store.getPixel(1, 1)).toEqual(RED);
    expect(store.getPixel(2, 2)).toEqual(WHITE);
  });
});

describe("clipAlphaToCoverage (DOC-IMG-01)", () => {
  it("multiplies alpha by coverage and keeps straight colors", () => {
    const surface = new Surface(2, 1);
    surface.data.set([10, 20, 30, 200, 10, 20, 30, 200]);
    clipAlphaToCoverage(surface, new Uint8Array([255, 128]));
    expect([...surface.data]).toEqual([10, 20, 30, 200, 10, 20, 30, 100]);
  });

  it("clears alpha where coverage is zero", () => {
    const surface = new Surface(1, 1);
    surface.data.set([1, 2, 3, 255]);
    clipAlphaToCoverage(surface, new Uint8Array([0]));
    expect([...surface.data]).toEqual([1, 2, 3, 0]);
  });
});
