import { describe, expect, it } from "vitest";
import { type ColorRgba8, rgba8, TRANSPARENT } from "./color";
import { EMPTY_RECT, isEmptyRect, type Rect, rect } from "./geometry";
import { MemoryAccountant, OutOfMemoryError } from "./memory";
import { Surface } from "./surface";
import { TILE_BYTES, TILE_SIZE, TiledPixelStore } from "./tiled-store";

const RED = rgba8(255, 0, 0);
const GREEN = rgba8(0, 255, 0, 77);

function pattern(w: number, h: number, seed = 0): Surface {
  const s = new Surface(w, h);
  for (let i = 0; i < s.data.length; i++) s.data[i] = (i * 31 + seed * 7) & 0xff;
  return s;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("TiledPixelStore", () => {
  it("gives each touched tile a new version, and 0 to untouched ones", () => {
    const store = new TiledPixelStore(600, 300);
    expect(store.tileVersion(0, 0)).toBe(0);
    store.fill(rgba8(1, 2, 3, 255), rect(10, 10, 5, 5));
    const first = store.tileVersion(0, 0);
    expect(first).toBeGreaterThan(0);
    expect(store.tileVersion(1, 0)).toBe(0);
    store.takeDirtyTiles();
    expect(store.tileVersion(0, 0)).toBe(first);
    store.writeRegion(new Surface(2, 2), 300, 10);
    expect(store.tileVersion(1, 0)).toBeGreaterThan(first);
    store.clear(rect(0, 0, 256, 256));
    expect(store.tileVersion(0, 0)).toBeGreaterThan(first);
    // Clearing a tile that was never allocated changes nothing.
    store.clear(rect(512, 0, 88, 256));
    expect(store.tileVersion(2, 0)).toBe(0);
  });

  it("uses 256 px RGBA8 straight-alpha sRGB tiles", () => {
    const s = new TiledPixelStore(600, 300);
    expect(TILE_SIZE).toBe(256);
    expect(TILE_BYTES).toBe(256 * 256 * 4);
    expect(s.format).toBe("rgba8");
    expect(s.colorProfile).toBe("srgb");
    expect([s.tilesX, s.tilesY]).toEqual([3, 2]);
    expect(s.tileBounds(2, 1)).toEqual(rect(512, 256, 88, 44));
  });

  it("validates dimensions against DOC-DOC-01", () => {
    expect(() => new TiledPixelStore(0, 10)).toThrow(RangeError);
    expect(() => new TiledPixelStore(262_145, 10)).toThrow(RangeError);
    expect(new TiledPixelStore(262_144, 262_144).allocatedBytes).toBe(0);
  });

  it("estimates the full allocation size", () => {
    expect(TiledPixelStore.estimateBytes(256, 256)).toBe(TILE_BYTES);
    expect(TiledPixelStore.estimateBytes(257, 1)).toBe(2 * TILE_BYTES);
  });

  it("starts sparse and transparent", () => {
    const s = new TiledPixelStore(1000, 1000);
    expect(s.allocatedTileCount).toBe(0);
    expect(s.getPixel(500, 500)).toEqual(TRANSPARENT);
    expect(s.readRegion(rect(0, 0, 10, 10)).isTransparent()).toBe(true);
    expect(s.dirtyTileCount).toBe(0);
  });

  it("lists tiles overlapping a rectangle", () => {
    const s = new TiledPixelStore(1000, 600);
    expect(s.tilesInRect(rect(255, 0, 2, 1))).toEqual([
      { tx: 0, ty: 0 },
      { tx: 1, ty: 0 },
    ]);
    expect(s.tilesInRect(rect(-100, 500, 5000, 5000))).toHaveLength(4 * 2);
    expect(s.tilesInRect(rect(2000, 0, 5, 5))).toEqual([]);
  });

  it("sets and gets pixels across tile boundaries", () => {
    const s = new TiledPixelStore(600, 600);
    s.setPixel(255, 255, RED);
    s.setPixel(256, 256, GREEN);
    s.setPixel(-1, 3, RED);
    s.setPixel(600, 3, RED);
    expect(s.getPixel(255, 255)).toEqual(RED);
    expect(s.getPixel(256, 256)).toEqual(GREEN);
    expect(s.getPixel(-1, 3)).toEqual(TRANSPARENT);
    expect(s.allocatedTileCount).toBe(2);
  });

  it("writes and reads a region spanning several tiles", () => {
    const s = new TiledPixelStore(700, 700);
    const src = pattern(300, 300);
    expect(s.writeRegion(src, 200, 200)).toEqual(rect(200, 200, 300, 300));
    expect(s.allocatedTileCount).toBe(4);
    expect(firstDifference(s.readRegion(rect(200, 200, 300, 300)).data, src.data)).toBe(-1);
    expect(s.getPixel(199, 200)).toEqual(TRANSPARENT);
  });

  it("clips writes to the store and reads outside as transparent", () => {
    const s = new TiledPixelStore(100, 100);
    const src = pattern(50, 50);
    expect(s.writeRegion(src, 80, -10)).toEqual(rect(80, 0, 20, 40));
    const out = s.readRegion(rect(70, -20, 50, 50));
    expect(out.getPixel(0, 0)).toEqual(TRANSPARENT);
    expect(out.getPixel(10, 10)).toEqual(TRANSPARENT);
    expect(out.getPixel(10, 20)).toEqual(src.getPixel(0, 10));
    expect(out.getPixel(29, 49)).toEqual(src.getPixel(19, 39));
    expect(out.getPixel(30, 30)).toEqual(TRANSPARENT);
    expect(isEmptyRect(s.writeRegion(src, 500, 500))).toBe(true);
  });

  it("writes a sub-rectangle of the source", () => {
    const s = new TiledPixelStore(300, 300);
    const src = pattern(20, 20);
    s.writeRegion(src, 250, 250, rect(5, 5, 10, 10));
    expect(s.getPixel(250, 250)).toEqual(src.getPixel(5, 5));
    expect(s.getPixel(259, 259)).toEqual(src.getPixel(14, 14));
    expect(s.getPixel(260, 260)).toEqual(TRANSPARENT);
  });

  it("fills regions and frees tiles cleared completely", () => {
    const s = new TiledPixelStore(600, 300);
    s.fill(RED);
    expect(s.allocatedTileCount).toBe(6);
    expect(s.getPixel(599, 299)).toEqual(RED);
    s.clear(rect(0, 0, 256, 256));
    expect(s.allocatedTileCount).toBe(5);
    s.clear(rect(256, 0, 10, 10));
    expect(s.allocatedTileCount).toBe(5);
    expect(s.getPixel(260, 5)).toEqual(TRANSPARENT);
    expect(s.getPixel(270, 5)).toEqual(RED);
    // Edge tile (512..600 x 256..300) is freed when its in-image part is cleared.
    s.clear(rect(512, 256, 88, 44));
    expect(s.allocatedTileCount).toBe(4);
    s.clear();
    expect(s.allocatedTileCount).toBe(0);
  });

  it("does not allocate when clearing unallocated tiles", () => {
    const s = new TiledPixelStore(600, 600);
    s.clear(rect(10, 10, 20, 20));
    expect(s.allocatedTileCount).toBe(0);
    expect(s.dirtyTileCount).toBe(0);
  });

  it("copies regions between stores and within one store", () => {
    const a = new TiledPixelStore(600, 600);
    const src = pattern(300, 300, 3);
    a.writeRegion(src, 0, 0);
    const b = new TiledPixelStore(400, 400);
    expect(b.copyRegion(a, rect(100, 100, 200, 200), 250, 250)).toEqual(rect(250, 250, 150, 150));
    expect(b.getPixel(250, 250)).toEqual(src.getPixel(100, 100));
    expect(b.getPixel(399, 399)).toEqual(src.getPixel(249, 249));

    a.copyRegion(a, rect(0, 0, 300, 300), 50, 50);
    expect(firstDifference(a.readRegion(rect(50, 50, 300, 300)).data, src.data)).toBe(-1);
    expect(a.getPixel(10, 10)).toEqual(src.getPixel(10, 10));
  });

  it("tracks dirty tiles", () => {
    const s = new TiledPixelStore(1000, 600);
    s.setPixel(300, 300, RED);
    s.fill(GREEN, rect(0, 0, 10, 10));
    expect(s.isTileDirty(1, 1)).toBe(true);
    expect(s.dirtyTiles()).toEqual([
      { tx: 0, ty: 0 },
      { tx: 1, ty: 1 },
    ]);
    expect(s.dirtyBounds()).toEqual(rect(0, 0, 512, 512));
    expect(s.takeDirtyTiles()).toHaveLength(2);
    expect(s.dirtyTileCount).toBe(0);
    expect(s.dirtyBounds()).toEqual(EMPTY_RECT);

    s.markDirty(rect(900, 520, 500, 500));
    expect(s.dirtyTiles()).toEqual([{ tx: 3, ty: 2 }]);
    s.clearDirty();
    s.clear(rect(0, 0, 256, 256));
    expect(s.dirtyTiles()).toEqual([{ tx: 0, ty: 0 }]);
  });

  it("lists allocated tiles in row-major order", () => {
    const s = new TiledPixelStore(1000, 600);
    s.setPixel(300, 300, RED);
    s.setPixel(5, 5, GREEN);
    expect(s.allocatedTiles()).toEqual([
      { tx: 0, ty: 0 },
      { tx: 1, ty: 1 },
    ]);
    s.clear(rect(0, 0, 256, 256));
    expect(s.allocatedTiles()).toEqual([{ tx: 1, ty: 1 }]);
  });

  it("accounts tile memory in a shared accountant", () => {
    const m = new MemoryAccountant();
    const a = new TiledPixelStore(512, 512, { accountant: m });
    const b = new TiledPixelStore(512, 512, { accountant: m });
    a.fill(RED);
    b.setPixel(0, 0, RED);
    expect(a.allocatedBytes).toBe(4 * TILE_BYTES);
    expect(m.usedBytes).toBe(5 * TILE_BYTES);
    a.clear(rect(0, 0, 256, 256));
    expect(m.usedBytes).toBe(4 * TILE_BYTES);
    a.dispose();
    expect(a.allocatedTileCount).toBe(0);
    expect(m.usedBytes).toBe(TILE_BYTES);
  });

  it("fails atomically when the budget is exceeded", () => {
    const m = new MemoryAccountant(3 * TILE_BYTES);
    const s = new TiledPixelStore(1024, 256, { accountant: m });
    s.setPixel(0, 0, GREEN);
    s.clearDirty();
    expect(() => s.fill(RED)).toThrow(OutOfMemoryError);
    expect(() => s.writeRegion(pattern(1024, 10), 0, 0)).toThrow(OutOfMemoryError);
    expect(s.getPixel(0, 0)).toEqual(GREEN);
    expect(s.allocatedTileCount).toBe(1);
    expect(s.dirtyTileCount).toBe(0);
    expect(m.usedBytes).toBe(TILE_BYTES);
    s.fill(RED, rect(0, 0, 700, 1));
    expect(m.usedBytes).toBe(3 * TILE_BYTES);
  });

  it("matches a flat reference surface under random operations", () => {
    const rand = mulberry32(1234);
    const int = (n: number) => Math.floor(rand() * n);
    const randRect = (): Rect => rect(int(900) - 100, int(700) - 100, int(400), int(400));
    const randColor = (): ColorRgba8 =>
      rand() < 0.3 ? TRANSPARENT : rgba8(int(256), int(256), int(256), int(256));
    const w = 700;
    const h = 520;
    const store = new TiledPixelStore(w, h);
    const ref = new Surface(w, h);

    for (let step = 0; step < 60; step++) {
      const op = int(4);
      if (op === 0) {
        const c = randColor();
        const r = randRect();
        store.fill(c, r);
        ref.fill(c, r);
      } else if (op === 1) {
        const src = pattern(int(300) + 1, int(300) + 1, step);
        const [x, y] = [int(w + 200) - 100, int(h + 200) - 100];
        store.writeRegion(src, x, y);
        ref.copyFrom(src, src.bounds, x, y);
      } else if (op === 2) {
        const r = randRect();
        const [x, y] = [int(w), int(h)];
        store.copyRegion(store, r, x, y);
        const moved = new Surface(r.width, r.height);
        moved.copyFrom(ref, r, 0, 0);
        ref.copyFrom(moved, moved.bounds, x, y);
      } else {
        const r = randRect();
        const x = int(w);
        const y = int(h);
        store.setPixel(x, y, randColor());
        ref.setPixel(x, y, store.getPixel(x, y));
        expect(firstDifference(store.readRegion(r).data, readFlat(ref, r).data)).toBe(-1);
      }
    }
    expect(firstDifference(store.readRegion(store.bounds).data, ref.data)).toBe(-1);
  });
});

/** Index of the first differing byte, or -1 when equal (deep equality is too slow at this size). */
function firstDifference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

function readFlat(s: Surface, r: Rect): Surface {
  const out = new Surface(r.width, r.height);
  out.copyFrom(s, r, 0, 0);
  return out;
}

describe("uniformColor (L9)", () => {
  it("knows the color of a tile a fill covered whole, until anything else writes it", () => {
    const store = new TiledPixelStore(600, 300);
    const red = rgba8(255, 0, 0);
    store.fill(red);
    expect(store.uniformColor(0, 0)).toEqual(red);
    // An edge tile is only partly inside the image, so a fill never covers it whole.
    expect(store.uniformColor(2, 0)).toBeUndefined();
    store.setPixel(3, 3, rgba8(0, 0, 255));
    expect(store.uniformColor(0, 0)).toBeUndefined();
    store.fill(red, rect(256, 0, 256, 256));
    expect(store.uniformColor(1, 0)).toEqual(red);
    store.writeRegion(new Surface(2, 2), 260, 4);
    expect(store.uniformColor(1, 0)).toBeUndefined();
    store.fill(red, rect(256, 0, 256, 256));
    store.clear(rect(256, 0, 256, 256));
    expect(store.uniformColor(1, 0)).toBeUndefined();
  });
});
