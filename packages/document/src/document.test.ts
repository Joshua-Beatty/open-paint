/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it } from "vitest";
import { LayerBlendMode } from "./blend-mode";
import { BLACK, rgba8, TRANSPARENT, WHITE } from "./color";
import { BACKGROUND_LAYER_NAME, Document, LayerError } from "./document";
import { rect } from "./geometry";
import type { Layer } from "./layer";
import { MAX_IMAGE_SIZE } from "./limits";
import { MemoryAccountant, OutOfMemoryError } from "./memory";
import { DEFAULT_RESOLUTION, type Resolution } from "./resolution";
import { rectPolygon } from "./selection-polygons";
import { TILE_BYTES } from "./tiled-store";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const RED = rgba8(255, 0, 0);
const BLUE = rgba8(0, 0, 255);

function names(doc: Document): string[] {
  return doc.layers.map((layer) => layer.name);
}

describe("Document creation (DOC-DOC-07)", () => {
  it("creates a blank document with one opaque white Background layer", () => {
    const doc = Document.createBlank({ width: 800, height: 600 });
    expect(doc.width).toBe(800);
    expect(doc.height).toBe(600);
    expect(doc.resolution).toEqual(DEFAULT_RESOLUTION);
    expect(doc.layerCount).toBe(1);
    const background = doc.layers[0];
    expect(background?.name).toBe(BACKGROUND_LAYER_NAME);
    expect(background?.isBackground).toBe(true);
    expect(background?.visible).toBe(true);
    expect(background?.opacity).toBe(255);
    expect(background?.blendMode).toBe(LayerBlendMode.normal);
    expect(background?.pixels.getPixel(0, 0)).toEqual(WHITE);
    expect(background?.pixels.getPixel(799, 599)).toEqual(WHITE);
    expect(doc.activeLayer).toBe(background);
    expect(doc.dirty).toBe(false);
  });

  it("uses the resolution it was given", () => {
    const resolution: Resolution = { unit: "centimeter", x: 37.8, y: 37.8 };
    expect(Document.createBlank({ width: 4, height: 4, resolution }).resolution).toEqual(
      resolution,
    );
  });

  it("enforces the DOC-DOC-01 size limits", () => {
    expect(() => new Document({ width: 0, height: 1 })).toThrow(RangeError);
    expect(() => new Document({ width: 1, height: MAX_IMAGE_SIZE + 1 })).toThrow(RangeError);
    expect(() => new Document({ width: 1.5, height: 1 })).toThrow(RangeError);
    expect(() => new Document({ width: MAX_IMAGE_SIZE, height: 1 })).not.toThrow();
  });

  it("rejects invalid resolutions (DOC-DOC-03)", () => {
    expect(
      () => new Document({ width: 1, height: 1, resolution: { unit: "pixel", x: 2, y: 1 } }),
    ).toThrow(RangeError);
    const doc = new Document({ width: 1, height: 1 });
    expect(() => doc.setResolution({ unit: "inch", x: 0, y: 96 })).toThrow(RangeError);
  });
});

describe("Document state and change notification (DOC-DOC-06)", () => {
  it("sets dirty on history-producing changes and clears it with markClean", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.addLayer();
    expect(doc.dirty).toBe(true);
    doc.markClean();
    expect(doc.dirty).toBe(false);
  });

  it("notifies subscribers until they unsubscribe", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    let calls = 0;
    const unsubscribe = doc.subscribe(() => {
      calls++;
    });
    doc.addLayer();
    expect(calls).toBe(1);
    unsubscribe();
    doc.addLayer();
    expect(calls).toBe(1);
  });

  it("changes the resolution with the dirty flag", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.setResolution({ unit: "centimeter", x: 100, y: 100 });
    expect(doc.resolution.unit).toBe("centimeter");
    expect(doc.dirty).toBe(true);
  });
});

describe("Add layer (DOC-LYR-05a, DOC-LYR-03)", () => {
  it("inserts a transparent layer above the active layer, named by the count before the add", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    const second = doc.addLayer();
    expect(second.name).toBe("Layer 2");
    expect(second.pixels.allocatedTileCount).toBe(0);
    expect(doc.activeLayer).toBe(second);
    expect(names(doc)).toEqual([BACKGROUND_LAYER_NAME, "Layer 2"]);

    const bottom = doc.layers[0];
    if (!bottom) throw new Error("missing background");
    doc.setActiveLayer(bottom);
    const third = doc.addLayer();
    expect(third.name).toBe("Layer 3");
    expect(names(doc)).toEqual([BACKGROUND_LAYER_NAME, "Layer 3", "Layer 2"]);
    expect(third.isBackground).toBe(false);
  });

  it("gives every layer a distinct id", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    const ids = [doc.layers[0]?.id, doc.addLayer().id, doc.addLayer().id];
    expect(new Set(ids).size).toBe(3);
  });
});

describe("Delete layer (DOC-LYR-05b)", () => {
  it("refuses to remove the last layer", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    expect(() => doc.deleteActiveLayer()).toThrow(LayerError);
    try {
      doc.deleteActiveLayer();
    } catch (error) {
      expect((error as LayerError).reason).toBe("last-layer");
    }
    expect(doc.layerCount).toBe(1);
  });

  it("removes the active layer without confirmation and activates the layer below", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    const top = doc.addLayer();
    doc.deleteActiveLayer();
    expect(doc.layerCount).toBe(1);
    expect(doc.layers).not.toContain(top);
    expect(doc.activeLayer).toBe(doc.layers[0]);
    expect(doc.dirty).toBe(true);
  });
});

describe("Duplicate layer (DOC-LYR-05c)", () => {
  it("clones pixels and properties above the source, keeping the name and metadata", () => {
    const doc = Document.createBlank({ width: 300, height: 300 });
    const background = doc.layers[0];
    if (!background) throw new Error("missing background");
    background.metadata.set("note", "kept");
    background.pixels.fill(BLUE, { x: 0, y: 0, width: 300, height: 10 });
    doc.setActiveLayer(background);
    const copy = doc.duplicateActiveLayer();

    expect(names(doc)).toEqual([BACKGROUND_LAYER_NAME, BACKGROUND_LAYER_NAME]);
    expect(doc.layers[1]).toBe(copy);
    expect(copy.isBackground).toBe(false);
    expect(copy.metadata.get("note")).toBe("kept");
    expect(copy.pixels.getPixel(299, 299)).toEqual(WHITE);
    expect(copy.pixels.getPixel(5, 5)).toEqual(BLUE);

    copy.pixels.fill(BLACK);
    expect(background.pixels.getPixel(5, 5)).toEqual(BLUE);
    expect(doc.activeLayer).toBe(copy);
  });
});

describe("Merge layer down (DOC-LYR-05d)", () => {
  it("refuses to merge the bottom layer", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    try {
      doc.mergeActiveLayerDown();
      expect.unreachable("merging the bottom layer must throw");
    } catch (error) {
      expect((error as LayerError).reason).toBe("no-layer-below");
    }
  });

  it("composites with the upper layer's blend mode and opacity and keeps the lower layer's properties", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    const lower = doc.layers[0];
    if (!lower) throw new Error("missing background");
    lower.applyProperties({ name: "Base", opacity: 100, visible: false });
    const upper = doc.addLayer();
    upper.pixels.fill(rgba8(255, 0, 0, 128));
    doc.mergeActiveLayerDown();

    expect(doc.layerCount).toBe(1);
    expect(doc.activeLayer).toBe(lower);
    expect(lower.name).toBe("Base");
    expect(lower.opacity).toBe(100);
    expect(lower.visible).toBe(false);
    expect(lower.pixels.getPixel(2, 2)).toEqual(rgba8(255, 127, 127, 255));
  });

  it("uses the upper layer's blend mode", () => {
    const doc = Document.createBlank({ width: 2, height: 2 });
    const upper = doc.addLayer();
    upper.applyProperties({ blendMode: LayerBlendMode.multiply });
    upper.pixels.fill(rgba8(128, 128, 128));
    doc.mergeActiveLayerDown();
    expect(doc.layers[0]?.pixels.getPixel(0, 0)).toEqual(rgba8(128, 128, 128));
  });

  it("still merges a hidden upper layer", () => {
    const doc = Document.createBlank({ width: 2, height: 2 });
    const upper = doc.addLayer();
    upper.applyProperties({ visible: false });
    upper.pixels.fill(BLACK);
    doc.mergeActiveLayerDown();
    expect(doc.layers[0]?.pixels.getPixel(0, 0)).toEqual(BLACK);
  });

  it("leaves the lower layer unchanged where the upper layer is transparent", () => {
    const doc = Document.createBlank({ width: 300, height: 300 });
    const upper = doc.addLayer();
    upper.pixels.setPixel(299, 299, RED);
    doc.mergeActiveLayerDown();
    expect(doc.layers[0]?.pixels.getPixel(0, 0)).toEqual(WHITE);
    expect(doc.layers[0]?.pixels.getPixel(299, 299)).toEqual(RED);
  });
});

describe("Move layers (DOC-LYR-05j..m)", () => {
  it("moves the active layer one step or to the ends, and reports no-ops at the edges", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.addLayer();
    doc.addLayer();
    expect(names(doc)).toEqual([BACKGROUND_LAYER_NAME, "Layer 2", "Layer 3"]);
    const top = doc.activeLayer;

    expect(doc.moveActiveLayerUp()).toBe(false);
    expect(doc.moveActiveLayerDown()).toBe(true);
    expect(names(doc)).toEqual([BACKGROUND_LAYER_NAME, "Layer 3", "Layer 2"]);
    expect(doc.activeLayer).toBe(top);

    expect(doc.moveActiveLayerDown()).toBe(true);
    expect(names(doc)).toEqual(["Layer 3", BACKGROUND_LAYER_NAME, "Layer 2"]);
    expect(doc.moveActiveLayerDown()).toBe(false);

    expect(doc.moveActiveLayerUp()).toBe(true);
    expect(doc.moveActiveLayerToTop()).toBe(true);
    expect(names(doc)).toEqual([BACKGROUND_LAYER_NAME, "Layer 2", "Layer 3"]);
    expect(doc.moveActiveLayerToTop()).toBe(false);

    expect(doc.moveActiveLayerToBottom()).toBe(true);
    expect(names(doc)).toEqual(["Layer 3", BACKGROUND_LAYER_NAME, "Layer 2"]);
    expect(doc.moveActiveLayerToBottom()).toBe(false);
  });

  it("moves the active layer to an index and swaps it with another, with their history names", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.addLayer();
    doc.addLayer();
    const top = doc.activeLayer;

    expect(doc.moveActiveLayerTo(2)).toBe(false);
    expect(doc.moveActiveLayerTo(0)).toBe(true);
    expect(names(doc)).toEqual(["Layer 3", BACKGROUND_LAYER_NAME, "Layer 2"]);
    expect(doc.history.undoName).toBe("Move Layer");
    expect(doc.activeLayer).toBe(top);

    expect(doc.swapActiveLayerWith(0)).toBe(false);
    expect(doc.swapActiveLayerWith(1)).toBe(true);
    expect(names(doc)).toEqual([BACKGROUND_LAYER_NAME, "Layer 3", "Layer 2"]);
    expect(doc.history.undoName).toBe("Swap Layer");
    expect(doc.activeLayer).toBe(top);

    expect(() => doc.moveActiveLayerTo(3)).toThrow(RangeError);
    expect(() => doc.swapActiveLayerWith(-1)).toThrow(RangeError);
    expect(() => doc.moveActiveLayerTo(1.5)).toThrow(RangeError);
  });
});

describe("Flip and rotate layer (DOC-LYR-05f..h)", () => {
  function markedDocument(): { doc: Document; layer: Layer } {
    const doc = Document.createBlank({ width: 300, height: 300 });
    const layer = doc.addLayer();
    layer.pixels.setPixel(10, 20, RED);
    layer.pixels.setPixel(299, 299, BLUE);
    return { doc, layer };
  }

  it("mirrors the active layer horizontally across tile boundaries", () => {
    const { doc, layer } = markedDocument();
    doc.flipActiveLayerHorizontal();
    expect(layer.pixels.getPixel(289, 20)).toEqual(RED);
    expect(layer.pixels.getPixel(0, 299)).toEqual(BLUE);
    expect(layer.pixels.getPixel(10, 20)).toEqual(TRANSPARENT);
    expect(doc.dirty).toBe(true);
  });

  it("mirrors the active layer vertically", () => {
    const { doc, layer } = markedDocument();
    doc.flipActiveLayerVertical();
    expect(layer.pixels.getPixel(10, 279)).toEqual(RED);
    expect(layer.pixels.getPixel(299, 0)).toEqual(BLUE);
  });

  it("rotates the active layer 180 degrees, and two flips restore the original", () => {
    const { doc, layer } = markedDocument();
    doc.rotateActiveLayer180();
    expect(layer.pixels.getPixel(289, 279)).toEqual(RED);
    expect(layer.pixels.getPixel(0, 0)).toEqual(BLUE);
    doc.rotateActiveLayer180();
    expect(layer.pixels.getPixel(10, 20)).toEqual(RED);
    expect(layer.pixels.getPixel(299, 299)).toEqual(BLUE);
  });

  it("leaves the other layers alone", () => {
    const { doc } = markedDocument();
    doc.flipActiveLayerHorizontal();
    expect(doc.layers[0]?.pixels.getPixel(0, 0)).toEqual(WHITE);
  });
});

describe("Set layer properties (DOC-LYR-02)", () => {
  it("applies changes, marks dirty only when a value changed, and rejects invalid values", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    expect(doc.setActiveLayerProperties({ opacity: 128 })).toBe(true);
    expect(doc.activeLayer?.opacity).toBe(128);
    expect(doc.dirty).toBe(true);

    doc.markClean();
    expect(doc.setActiveLayerProperties({ opacity: 128 })).toBe(false);
    expect(doc.dirty).toBe(false);

    expect(() => doc.setActiveLayerProperties({ opacity: 256 })).toThrow(RangeError);
    expect(() => doc.setActiveLayerProperties({ blendMode: 14 as LayerBlendMode })).toThrow(
      RangeError,
    );
    expect(doc.activeLayer?.opacity).toBe(128);
  });

  it("truncates long names", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.setActiveLayerProperties({ name: "x".repeat(300) });
    expect(doc.activeLayer?.name).toHaveLength(256);
  });

  it("previews properties without history, dirty state changes, or a stale commit", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    const before = doc.history.entries.length;
    let notified = 0;
    doc.subscribe(() => {
      notified += 1;
    });

    doc.previewActiveLayerProperties({ opacity: 40, name: "Ink" });
    expect(doc.activeLayer?.opacity).toBe(40);
    expect(doc.activeLayer?.name).toBe("Ink");
    expect(doc.history.entries.length).toBe(before);
    expect(doc.dirty).toBe(false);
    expect(notified).toBe(1);

    doc.previewActiveLayerProperties({ opacity: 255, name: "Background" });
    expect(doc.setActiveLayerProperties({ opacity: 255, name: "Background" })).toBe(false);
    expect(doc.setActiveLayerProperties({ opacity: 128 })).toBe(true);
    expect(doc.history.entries.length).toBe(before + 1);
    expect(doc.dirty).toBe(true);
  });

  it("previews layer pixels without history, and rejects a layer outside the document", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("the blank document has a layer");
    const before = doc.history.entries.length;
    let notified = 0;
    doc.subscribe(() => {
      notified += 1;
    });

    doc.previewLayerPixels(layer, (pixels) =>
      pixels.fill(BLACK, { x: 0, y: 0, width: 2, height: 2 }),
    );
    expect(layer.pixels.readRegion({ x: 0, y: 0, width: 1, height: 1 }).data.slice(0, 4)).toEqual(
      new Uint8ClampedArray([0, 0, 0, 255]),
    );
    expect(doc.history.entries.length).toBe(before);
    expect(doc.dirty).toBe(false);
    expect(notified).toBe(1);

    const other = Document.createBlank({ width: 4, height: 4 }).activeLayer;
    if (other === undefined) throw new Error("the blank document has a layer");
    expect(() => doc.previewLayerPixels(other, () => undefined)).toThrow(RangeError);
  });

  it("restores a preview's pixels and selection even while a background job holds the document", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("the blank document has a layer");
    const area = { x: 0, y: 0, width: 2, height: 2 };
    const original = layer.pixels.readRegion(area);
    const selection = doc.selection;
    doc.previewLayerPixels(layer, (pixels) => pixels.fill(BLACK, area));
    doc.previewSelection(selection.combine([rectPolygon(rect(0, 0, 2, 2))], "union"));
    let notified = 0;
    doc.subscribe(() => {
      notified += 1;
    });

    const release = doc.history.hold();
    expect(() => doc.previewLayerPixels(layer, () => undefined)).toThrow();
    doc.restoreLayerPixels(layer, (pixels) => pixels.writeRegion(original, 0, 0));
    doc.restoreSelection(selection);
    release();

    expect(layer.pixels.readRegion(area).data).toEqual(original.data);
    expect(doc.selection).toBe(selection);
    expect(notified).toBe(2);
  });

  it("tells listeners about a preview written straight into a layer's store", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("the blank document has a layer");
    let notified = 0;
    doc.subscribe(() => {
      notified += 1;
    });
    doc.layerPreviewChanged(layer);
    const other = Document.createBlank({ width: 4, height: 4 }).activeLayer;
    if (other === undefined) throw new Error("the blank document has a layer");
    doc.layerPreviewChanged(other);
    expect(notified).toBe(1);
    expect(doc.dirty).toBe(false);
  });
});

describe("Memory budget (WEB-MEM-03, ARC-05-05)", () => {
  it("fails to create a document that does not fit, leaving no reservation", () => {
    const accountant = new MemoryAccountant(TILE_BYTES);
    expect(() => Document.createBlank({ width: 300, height: 300, accountant })).toThrow(
      OutOfMemoryError,
    );
    expect(accountant.usedBytes).toBe(0);
  });

  it("leaves the document unchanged when a duplicate does not fit", () => {
    const accountant = new MemoryAccountant(4 * TILE_BYTES);
    const doc = Document.createBlank({ width: 300, height: 300, accountant });
    expect(() => doc.duplicateActiveLayer()).toThrow(OutOfMemoryError);
    expect(doc.layerCount).toBe(1);
    expect(accountant.usedBytes).toBe(4 * TILE_BYTES);
  });

  it("releases every layer's memory when disposed", () => {
    const accountant = new MemoryAccountant();
    const doc = Document.createBlank({ width: 300, height: 300, accountant });
    doc.addLayer().pixels.setPixel(0, 0, RED);
    expect(accountant.usedBytes).toBeGreaterThan(0);
    doc.dispose();
    expect(accountant.usedBytes).toBe(0);
    expect(doc.layerCount).toBe(0);
  });
});

describe("recordLayerPixels (L9)", () => {
  it("records pixels already on the layer, with the given earlier pixels as the before-state", async () => {
    const doc = Document.createBlank({ width: 300, height: 280 });
    const layer = doc.activeLayer as Layer;
    const area = rect(10, 250, 280, 20);
    const before = layer.pixels.readRegion(area);
    doc.previewLayerPixels(layer, (pixels) => pixels.fill(RED, area));
    doc.recordLayerPixels("Blur", layer, area, before);
    expect(doc.history.undoName).toBe("Blur");
    expect(layer.pixels.getPixel(20, 260)).toEqual(RED);
    await doc.history.undo();
    expect(layer.pixels.getPixel(20, 260)).toEqual(WHITE);
    expect(layer.pixels.getPixel(299, 279)).toEqual(WHITE);
    await doc.history.redo();
    expect(layer.pixels.getPixel(20, 260)).toEqual(RED);
    expect(layer.pixels.getPixel(5, 260)).toEqual(WHITE);
  });
});
