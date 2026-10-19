import { type LayerOverlay, rect, Surface, TiledPixelStore } from "@openpaint/document";
import { describe, expect, it } from "vitest";
import {
  DocumentMirror,
  DocumentReplica,
  type DocumentSync,
  type MirroredDocument,
} from "./document-sync";

const RED = { r: 200, g: 10, b: 10, a: 255 };
const BLUE = { r: 10, g: 10, b: 200, a: 255 };

function documentOf(
  width: number,
  height: number,
  layers: { id: number; pixels: TiledPixelStore; opacity?: number; visible?: boolean }[],
): MirroredDocument {
  return {
    width,
    height,
    layers: layers.map((layer) => ({
      id: layer.id,
      visible: layer.visible ?? true,
      opacity: layer.opacity ?? 255,
      blendMode: 0,
      pixels: layer.pixels,
    })),
  };
}

describe("DocumentMirror overlays (TL-FRAME-01)", () => {
  it("shows a pending result over the layer in the engine, and takes it away, leaving the layer as it is", () => {
    const layer = new TiledPixelStore(600, 300);
    layer.fill(RED, rect(0, 0, 600, 300));
    const mirror = new DocumentMirror();
    const replica = new DocumentReplica();
    let overlay: LayerOverlay | undefined;
    const doc = (): MirroredDocument => ({
      width: 600,
      height: 300,
      layers: [{ id: 1, visible: true, opacity: 255, blendMode: 0, pixels: layer, overlay }],
    });
    replica.apply(mirror.describe(doc()));
    const patch = new Surface(10, 10);
    patch.fill(BLUE);
    overlay = { patches: [{ area: rect(300, 5, 10, 10), output: patch }] };
    const sync = mirror.describe(doc());
    expect(sync.tiles[0]?.tiles.map(({ tx, ty, rect: part }) => [tx, ty, part])).toEqual([
      [1, 0, rect(44, 5, 10, 10)],
    ]);
    const store = replica.apply(sync).document.layers[0]?.store;
    expect(store?.getPixel(305, 10)).toEqual(BLUE);
    expect(layer.getPixel(305, 10)).toEqual(RED);
    // Unchanged: nothing is sent again.
    expect(mirror.describe(doc()).tiles[0]?.tiles).toEqual([]);
    // A dirty tile under the overlay goes with the overlay drawn in.
    layer.fill(RED, rect(290, 0, 30, 30));
    replica.apply(mirror.describe(doc()));
    expect(store?.getPixel(305, 10)).toEqual(BLUE);
    overlay = undefined;
    replica.apply(mirror.describe(doc()));
    expect(store?.getPixel(305, 10)).toEqual(RED);
  });

  it("sends only the tiles whose patches changed (L2)", () => {
    const layer = new TiledPixelStore(600, 300);
    const mirror = new DocumentMirror();
    const patch = (x: number) => ({ area: rect(x, 0, 10, 10), output: new Surface(10, 10) });
    const first = patch(0);
    let overlay: LayerOverlay | undefined = { patches: [first] };
    const doc = (): MirroredDocument => ({
      width: 600,
      height: 300,
      layers: [{ id: 1, visible: true, opacity: 255, blendMode: 0, pixels: layer, overlay }],
    });
    mirror.describe(doc());
    overlay = { patches: [first, patch(300)] };
    expect(mirror.describe(doc()).tiles[0]?.tiles.map(({ tx }) => tx)).toEqual([1]);
  });
});

describe("DocumentMirror and DocumentReplica", () => {
  it("sends a full sync that the replica draws exactly", () => {
    const bottom = new TiledPixelStore(600, 300);
    const top = new TiledPixelStore(600, 300);
    bottom.fill(RED, rect(0, 0, 300, 300));
    top.fill(BLUE, rect(250, 0, 100, 10));
    const replica = new DocumentReplica();

    const { document, full } = replica.apply(
      new DocumentMirror().describe(
        documentOf(600, 300, [
          { id: 1, pixels: bottom },
          { id: 2, pixels: top },
        ]),
      ),
    );

    expect(full).toBe(true);
    expect(document.width).toBe(600);
    expect(document.layers.map((layer) => layer.mode)).toEqual([0, 0]);
    expect(document.layers[0]?.store.getPixel(5, 5)).toEqual(RED);
    expect(document.layers[1]?.store.getPixel(255, 5)).toEqual(BLUE);
    expect(document.layers[1]?.store.getPixel(0, 299)).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it("sends only dirty tiles after an edit and keeps the composite", () => {
    const layer = new TiledPixelStore(600, 300);
    const mirror = new DocumentMirror();
    const replica = new DocumentReplica();
    const doc = documentOf(600, 300, [{ id: 1, pixels: layer }]);
    const first = replica.apply(mirror.describe(doc)).document;

    layer.fill(RED, rect(300, 0, 10, 10));
    const sync = mirror.describe(doc);
    const { document, full } = replica.apply(sync);

    expect(full).toBe(false);
    expect(document).toBe(first);
    expect(sync.tiles[0]?.tiles.map(({ tx, ty }) => [tx, ty])).toEqual([[1, 0]]);
    expect(document.layers[0]?.store.getPixel(305, 5)).toEqual(RED);
  });

  it("clears a tile that became transparent", () => {
    const layer = new TiledPixelStore(300, 300);
    layer.fill(RED, rect(0, 0, 300, 300));
    const mirror = new DocumentMirror();
    const replica = new DocumentReplica();
    const doc = documentOf(300, 300, [{ id: 1, pixels: layer }]);
    replica.apply(mirror.describe(doc));

    layer.clear(rect(0, 0, 256, 256));
    const sync = mirror.describe(doc);
    const { document } = replica.apply(sync);

    expect(sync.tiles[0]?.tiles.find(({ tx, ty }) => tx === 0 && ty === 0)?.pixels).toBeUndefined();
    expect(document.layers[0]?.store.getPixel(10, 10)).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(document.layers[0]?.store.getPixel(280, 280)).toEqual(RED);
  });

  it("restacks without resending pixels when a layer's properties change", () => {
    const layer = new TiledPixelStore(10, 10);
    layer.fill(RED, rect(0, 0, 10, 10));
    const mirror = new DocumentMirror();
    const replica = new DocumentReplica();
    const first = replica.apply(mirror.describe(documentOf(10, 10, [{ id: 1, pixels: layer }])));

    const { document, full, restacked } = replica.apply(
      mirror.describe(documentOf(10, 10, [{ id: 1, pixels: layer, opacity: 128 }])),
    );

    expect(full).toBe(false);
    expect(restacked).toBe(true);
    expect(document.layers[0]?.opacity).toBe(128);
    expect(document.layers[0]?.store).toBe(first.document.layers[0]?.store);
    expect(document.layers[0]?.store.getPixel(5, 5)).toEqual(RED);
  });

  it("sends a layer's live filter, its coverage once, and restacks only when it changes", () => {
    const layer = new TiledPixelStore(10, 10);
    layer.fill(RED, rect(0, 0, 10, 10));
    const mirror = new DocumentMirror();
    const replica = new DocumentReplica();
    const plain = documentOf(10, 10, [{ id: 1, pixels: layer }]);
    replica.apply(mirror.describe(plain));
    const coverage = new Uint8Array(16).fill(255);
    const withLive = (params: unknown) => ({
      ...plain,
      layers: plain.layers.map((entry) => ({
        ...entry,
        livePreview: { effectId: "sepia", params, region: rect(2, 2, 4, 4), coverage },
      })),
    });

    const first = mirror.describe(withLive({ intensity: 10 }));
    expect(first.layers[0]?.live?.coverage).toEqual(coverage);
    expect(first.tiles[0]?.tiles).toEqual([]);
    const shown = replica.apply(first);
    expect(shown.restacked).toBe(true);
    const live = shown.document.layers[0]?.live;
    expect(live).toMatchObject({ effectId: "sepia", params: { intensity: 10 }, coverage });

    // The same filter again is no change; new parameters send no coverage but keep it.
    expect(replica.apply(mirror.describe(withLive({ intensity: 10 }))).restacked).toBe(false);
    const next = mirror.describe(withLive({ intensity: 60 }));
    expect(next.layers[0]?.live?.coverage).toBeUndefined();
    const changed = replica.apply(next);
    expect(changed.restacked).toBe(true);
    expect(changed.document.layers[0]?.live).toMatchObject({ params: { intensity: 60 }, coverage });

    const cleared = replica.apply(mirror.describe(plain));
    expect(cleared.restacked).toBe(true);
    expect(cleared.document.layers[0]?.live).toBeUndefined();
    // Shown again after it was taken down, the coverage goes along again.
    expect(mirror.describe(withLive({ intensity: 60 })).layers[0]?.live?.coverage).toEqual(
      coverage,
    );
  });

  it("sends floating content and its base once per key, then only placements, without restacking", () => {
    const layer = new TiledPixelStore(10, 10);
    const mirror = new DocumentMirror();
    const replica = new DocumentReplica();
    const plain = documentOf(10, 10, [{ id: 1, pixels: layer }]);
    const first = replica.apply(mirror.describe(plain)).document;
    const pixels = new Surface(4, 3);
    pixels.fill(RED);
    const content = { pixels, coverage: new Uint8Array(12).fill(255) };
    const base = { region: rect(0, 0, 256, 256), pixels: new Surface(256, 256) };
    const withFloat = (e: number) => ({
      ...plain,
      layers: plain.layers.map((entry) => ({
        ...entry,
        floatPreview: {
          content,
          base,
          transform: { a: 1, b: 0, c: 0, d: 1, e, f: 2 },
          options: { sampling: "cubic" as const, linearLight: true },
          shape: [[0, 0, 4, 0, 4, 3]],
          quality: "antialiased" as const,
          stamps: [],
        },
      })),
    });

    const sync = mirror.describe(withFloat(1.5));
    expect(sync.layers[0]?.float?.content?.pixels.length).toBe(48);
    expect(sync.layers[0]?.float?.base?.region).toEqual(rect(0, 0, 256, 256));
    const shown = replica.apply(sync);
    expect(shown.restacked).toBe(false);
    expect(shown.document).toBe(first);
    expect(replica.float).toMatchObject({ layerId: 1, index: 0 });
    expect(replica.float?.placement.transform).toEqual([1, 0, 0, 1, 1.5, 2]);
    expect(replica.float?.placement.sampling).toBe(4);

    const next = mirror.describe(withFloat(2.5));
    expect(next.layers[0]?.float?.content).toBeUndefined();
    expect(next.layers[0]?.float?.base).toBeUndefined();
    replica.apply(next);
    expect(replica.float?.placement.transform[4]).toBe(2.5);
    expect(replica.float?.content.pixels.length).toBe(48);

    // Taken down, the worker keeps the content: shown again, only the placement goes.
    replica.apply(mirror.describe(plain));
    expect(replica.float).toBeUndefined();
    const again = mirror.describe(withFloat(3));
    expect(again.layers[0]?.float?.content).toBeUndefined();
    replica.apply(again);
    expect(replica.float?.placement.transform[4]).toBe(3);
  });

  it("empties a layer whose store is replaced, and drops deleted layers", () => {
    const mirror = new DocumentMirror();
    const replica = new DocumentReplica();
    const before = new TiledPixelStore(10, 10);
    before.fill(RED, rect(0, 0, 10, 10));
    const other = new TiledPixelStore(10, 10);
    other.fill(BLUE, rect(0, 0, 10, 10));
    replica.apply(
      mirror.describe(
        documentOf(10, 10, [
          { id: 1, pixels: before },
          { id: 2, pixels: other },
        ]),
      ),
    );

    const after = new TiledPixelStore(10, 10);
    after.fill(BLUE, rect(0, 0, 1, 1));
    const { document, full, restacked } = replica.apply(
      mirror.describe(documentOf(10, 10, [{ id: 1, pixels: after }])),
    );

    expect(full).toBe(false);
    expect(restacked).toBe(true);
    expect(document.layers).toHaveLength(1);
    expect(document.layers[0]?.store.getPixel(0, 0)).toEqual(BLUE);
    expect(document.layers[0]?.store.getPixel(5, 5)).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it("sends only the changed part of a tile, and the replica stays equal (L9)", () => {
    const layer = new TiledPixelStore(600, 300);
    layer.fill(RED, rect(0, 0, 600, 300));
    const mirror = new DocumentMirror();
    const replica = new DocumentReplica();
    const doc = documentOf(600, 300, [{ id: 1, pixels: layer }]);
    const { document } = replica.apply(mirror.describe(doc));

    layer.fill(BLUE, rect(260, 20, 5, 4));
    layer.fill(BLUE, rect(300, 30, 2, 2));
    const sync = mirror.describe(doc);
    const tile = sync.tiles[0]?.tiles[0];
    expect(sync.tiles[0]?.tiles).toHaveLength(1);
    expect(tile?.rect).toEqual(rect(4, 20, 42, 12));
    expect(tile?.pixels?.byteLength).toBe(42 * 12 * 4);
    const after = replica.apply(sync);
    expect(after.restacked).toBe(false);
    const all = layer.bounds;
    expect([...(document.layers[0]?.store.readRegion(all).data ?? [])]).toEqual([
      ...layer.readRegion(all).data,
    ]);
  });

  it("sends a tile allocated since the last sync whole", () => {
    const layer = new TiledPixelStore(600, 300);
    const mirror = new DocumentMirror();
    const doc = documentOf(600, 300, [{ id: 1, pixels: layer }]);
    mirror.describe(doc);
    layer.fill(RED, rect(10, 10, 2, 2));
    const tile = mirror.describe(doc).tiles[0]?.tiles[0];
    expect(tile?.rect).toBeUndefined();
    expect(tile?.pixels?.byteLength).toBe(256 * 256 * 4);
  });

  it("describes a missing document as an empty full sync", () => {
    const sync = new DocumentMirror().describe(undefined);
    const { document, full } = new DocumentReplica().apply(sync);

    expect(full).toBe(true);
    expect(document.layers).toEqual([]);
    expect(document.width).toBe(0);
  });

  it("sends the stack alone for a property change", () => {
    const layer = new TiledPixelStore(600, 300);
    layer.fill(RED, rect(0, 0, 600, 300));
    const mirror = new DocumentMirror();
    expect(mirror.describe(documentOf(600, 300, [{ id: 1, pixels: layer }])).full).toBe(true);

    const sync = mirror.describe(documentOf(600, 300, [{ id: 1, pixels: layer, opacity: 9 }]));

    expect(sync.full).toBe(false);
    expect(sync.layers[0]?.opacity).toBe(9);
    expect(sync.tiles[0]?.tiles).toEqual([]);
    expect(sync.reset).toBeUndefined();
  });

  it("resets only a new or replaced layer, and a new size is full", () => {
    const kept = new TiledPixelStore(600, 300);
    kept.fill(RED, rect(0, 0, 600, 300));
    const mirror = new DocumentMirror();
    mirror.describe(documentOf(600, 300, [{ id: 1, pixels: kept }]));
    const added = new TiledPixelStore(600, 300);
    added.fill(BLUE, rect(0, 0, 10, 10));

    const sync = mirror.describe(
      documentOf(600, 300, [
        { id: 1, pixels: kept },
        { id: 2, pixels: added },
      ]),
    );

    expect(sync.full).toBe(false);
    expect(sync.reset).toEqual([2]);
    expect(sync.tiles.map((layer) => layer.tiles.length)).toEqual([0, 1]);
    const bigger = new TiledPixelStore(700, 300);
    expect(mirror.describe(documentOf(700, 300, [{ id: 1, pixels: bigger }])).full).toBe(true);
  });

  it("leaves acknowledged tiles out of the next sync once, and invalidate forces a full one", () => {
    const layer = new TiledPixelStore(600, 300);
    const mirror = new DocumentMirror();
    const doc = documentOf(600, 300, [{ id: 1, pixels: layer }]);
    mirror.describe(doc);

    layer.fill(RED, rect(0, 0, 600, 10));
    mirror.acknowledge(layer, [{ tx: 0, ty: 0 }]);
    const sync = mirror.describe(doc);
    expect(sync.tiles[0]?.tiles.map(({ tx, ty }) => [tx, ty])).toEqual([
      [1, 0],
      [2, 0],
    ]);

    layer.fill(BLUE, rect(0, 0, 10, 10));
    expect(mirror.describe(doc).tiles[0]?.tiles.map(({ tx }) => tx)).toEqual([0]);
    mirror.invalidate();
    const full = mirror.describe(doc);
    expect(full.full).toBe(true);
    expect(full.tiles[0]?.tiles).toHaveLength(3);
  });

  it("rejects a delta for a layer the replica does not hold", () => {
    const layer = new TiledPixelStore(10, 10);
    const mirror = new DocumentMirror();
    const replica = new DocumentReplica();
    replica.apply(mirror.describe(documentOf(10, 10, [{ id: 1, pixels: layer }])));

    layer.fill(RED, rect(0, 0, 1, 1));
    const sync = mirror.describe(documentOf(10, 10, [{ id: 1, pixels: layer }]));
    const stranger: DocumentSync = {
      ...sync,
      tiles: [{ id: 9, tiles: sync.tiles[0]?.tiles ?? [] }],
    };

    expect(() => replica.apply(stranger)).toThrow("Layer 9");
  });
});

describe("full syncs (L9, L10)", () => {
  it("sends a tile of one color as its color, which the replica fills", () => {
    const layer = new TiledPixelStore(600, 300);
    layer.fill(RED, rect(0, 0, 512, 256));
    layer.setPixel(300, 10, BLUE);
    const sync = new DocumentMirror().describe(documentOf(600, 300, [{ id: 1, pixels: layer }]));
    const tiles = sync.tiles[0]?.tiles ?? [];
    expect(tiles.find(({ tx, ty }) => tx === 0 && ty === 0)?.fill).toBeDefined();
    expect(tiles.find(({ tx, ty }) => tx === 0 && ty === 0)?.pixels).toBeUndefined();
    expect(tiles.find(({ tx, ty }) => tx === 1 && ty === 0)?.pixels).toBeDefined();
    const { document } = new DocumentReplica().apply(sync);
    const store = document.layers[0]?.store;
    expect(
      firstDifference(
        store?.readRegion(store.bounds).data ?? [],
        layer.readRegion(layer.bounds).data,
      ),
    ).toBe(-1);
  });

  it("spreads a full sync over several describes within a byte budget", () => {
    const layer = new TiledPixelStore(1024, 512);
    for (let tx = 0; tx < 4; tx++) {
      for (let ty = 0; ty < 2; ty++) layer.setPixel(tx * 256 + 1, ty * 256 + 1, RED);
    }
    const mirror = new DocumentMirror();
    const replica = new DocumentReplica();
    const doc = documentOf(1024, 512, [{ id: 1, pixels: layer }]);
    const first = mirror.describe(doc, 3 * 256 * 256 * 4);
    expect(first.full).toBe(true);
    expect(first.tiles[0]?.tiles).toHaveLength(3);
    expect(mirror.pending).toBe(true);
    replica.apply(first);
    // An edit meanwhile goes out with the next slice.
    layer.setPixel(1000, 500, BLUE);
    let count = 1;
    while (mirror.pending) {
      const next = mirror.describe(doc, 3 * 256 * 256 * 4);
      expect(next.full).toBe(false);
      replica.apply(next);
      count += 1;
    }
    expect(count).toBe(3);
    const store = replica.apply(mirror.describe(doc)).document.layers[0]?.store;
    expect(
      firstDifference(
        store?.readRegion(store.bounds).data ?? [],
        layer.readRegion(layer.bounds).data,
      ),
    ).toBe(-1);
  });
});

/** The first index where two byte arrays differ, or -1; far faster than a deep equal on images. */
function firstDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}
