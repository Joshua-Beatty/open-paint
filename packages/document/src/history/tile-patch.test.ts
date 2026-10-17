import { describe, expect, it } from "vitest";
import { BLACK, rgba8, TRANSPARENT } from "../color";
import { rect } from "../geometry";
import { TiledPixelStore } from "../tiled-store";
import { captureTiles, captureTilesBefore, restoreTiles } from "./tile-patch";

const RED = rgba8(255, 0, 0);
const BLUE = rgba8(0, 0, 255, 128);

describe("tile patches (DOC-HIS-02, ARC-05-08)", () => {
  it("restores tiles exactly, including edge tiles and transparent tiles", () => {
    const store = new TiledPixelStore(300, 280);
    store.fill(RED, rect(0, 0, 300, 280));
    store.clear(rect(0, 0, 256, 256));
    store.setPixel(299, 279, BLUE);
    const patch = captureTiles(store);

    const target = new TiledPixelStore(300, 280);
    target.fill(BLACK);
    restoreTiles(target, patch);

    expect(target.getPixel(10, 10)).toEqual(TRANSPARENT);
    expect(target.getPixel(299, 10)).toEqual(RED);
    expect(target.getPixel(299, 279)).toEqual(BLUE);
    expect(target.getPixel(255, 255)).toEqual(TRANSPARENT);
    expect(target.getPixel(256, 256)).toEqual(RED);
    expect(target.allocatedTileCount).toBe(store.allocatedTileCount);
  });

  it("limits the capture to the tiles that overlap the area", () => {
    const store = new TiledPixelStore(600, 300);
    store.fill(RED);
    const area = rect(300, 0, 10, 10);
    const patch = captureTiles(store, area);

    const target = new TiledPixelStore(600, 300);
    target.fill(BLACK);
    restoreTiles(target, patch);
    expect(target.getPixel(300, 5)).toEqual(RED);
    expect(target.getPixel(0, 0)).toEqual(BLACK);
    expect(patch.length).toBe(4 + 9 + 256 * 256 * 4);
  });

  it("rebuilds the patch of an area from its earlier pixels after it was overwritten", () => {
    const store = new TiledPixelStore(600, 300);
    store.fill(RED, rect(0, 0, 400, 300));
    store.setPixel(5, 5, BLUE);
    const area = rect(250, 20, 300, 200);
    const before = store.readRegion(area);
    const expected = new TiledPixelStore(600, 300);
    restoreTiles(expected, captureTiles(store, area));
    store.fill(BLUE, area);
    const patch = captureTilesBefore(store, area, before);
    const target = new TiledPixelStore(600, 300);
    restoreTiles(target, patch);
    expect(target.readRegion(target.bounds)).toEqual(expected.readRegion(expected.bounds));
    expect(() => captureTilesBefore(store, area, store.readRegion(rect(0, 0, 4, 4)))).toThrow(
      RangeError,
    );
  });

  it("takes the earlier tiles whole when they are given as tiles", () => {
    const store = new TiledPixelStore(600, 300);
    store.fill(RED, rect(0, 0, 256, 256));
    const earlier = new Map([[0, store.getTile(0, 0)?.clone() ?? null]]);
    const area = rect(10, 10, 400, 20);
    const expected = captureTiles(store, area);
    store.fill(BLUE, area);
    const patch = captureTilesBefore(store, area, (tx, ty) => earlier.get(ty * 3 + tx) ?? null);
    expect(patch).toEqual(expected);
  });

  it("captures each tile once for a list of rectangles, and none between them", () => {
    const store = new TiledPixelStore(1024, 300);
    store.fill(RED);
    const patch = captureTiles(store, [rect(0, 0, 10, 10), rect(5, 5, 10, 10), rect(900, 0, 4, 4)]);
    expect(patch.length).toBe(4 + 2 * (9 + 256 * 256 * 4));
    const target = new TiledPixelStore(1024, 300);
    target.fill(BLACK);
    restoreTiles(target, patch);
    expect(target.getPixel(3, 3)).toEqual(RED);
    expect(target.getPixel(901, 1)).toEqual(RED);
    expect(target.getPixel(400, 1)).toEqual(BLACK);
  });

  it("restores a region over a store that has changed, clearing tiles the patch saw as empty", () => {
    const store = new TiledPixelStore(512, 256);
    const patch = captureTiles(store);
    store.fill(RED);
    expect(store.allocatedTileCount).toBe(2);
    restoreTiles(store, patch);
    expect(store.allocatedTileCount).toBe(0);
  });

  it("marks restored tiles dirty for upload", () => {
    const store = new TiledPixelStore(256, 256);
    store.fill(RED);
    const patch = captureTiles(store);
    store.clearDirty();
    restoreTiles(store, patch);
    expect(store.isTileDirty(0, 0)).toBe(true);
  });

  it("rejects malformed patches without changing the store", () => {
    const store = new TiledPixelStore(256, 256);
    store.fill(RED);
    const patch = captureTiles(store);
    const before = captureTiles(store);
    expect(() => restoreTiles(store, patch.subarray(0, 20))).toThrow(RangeError);
    expect(() => restoreTiles(store, new Uint8Array([1]))).toThrow(RangeError);
    const extra = new Uint8Array(patch.length + 1);
    extra.set(patch);
    expect(() => restoreTiles(store, extra)).toThrow(RangeError);
    expect(captureTiles(store)).toEqual(before);
  });

  it("rejects a tile outside the store", () => {
    const small = new TiledPixelStore(256, 256);
    const big = new TiledPixelStore(512, 512);
    big.fill(RED, rect(300, 300, 10, 10));
    expect(() => restoreTiles(small, captureTiles(big, rect(300, 300, 10, 10)))).toThrow(
      RangeError,
    );
  });
});
