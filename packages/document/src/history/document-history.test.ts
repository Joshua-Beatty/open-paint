/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it } from "vitest";
import { LayerBlendMode } from "../blend-mode";
import { BLACK, rgba8, TRANSPARENT, WHITE } from "../color";
import { BACKGROUND_LAYER_NAME, Document } from "../document";
import { rect } from "../geometry";
import type { Layer } from "../layer";
import { MemoryAccountant } from "../memory";
import { DEFAULT_RESOLUTION } from "../resolution";
import { Selection } from "../selection";
import { TILE_BYTES } from "../tiled-store";
import { MemorySpillStorage } from "./memory-spill-storage";
import { SpillStore } from "./spill-store";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const RED = rgba8(255, 0, 0);
const BLUE = rgba8(0, 0, 255);

function names(doc: Document): string[] {
  return doc.layers.map((layer) => layer.name);
}

function background(doc: Document): Layer {
  const layer = doc.layers[0];
  if (!layer) throw new Error("missing background");
  return layer;
}

/** A document that keeps its spilled undo data in an inspectable store. */
function documentWithSpill(
  options: {
    width?: number;
    height?: number;
    cacheBytes?: number;
    accountant?: MemoryAccountant;
  } = {},
) {
  const storage = new MemorySpillStorage();
  const spill = new SpillStore({ storage, cacheBytes: options.cacheBytes ?? 0, namespace: "doc" });
  const doc = Document.createBlank({
    width: options.width ?? 300,
    height: options.height ?? 300,
    spill,
    accountant: options.accountant,
  });
  return { doc, spill, storage };
}

describe("history items for layer commands (DOC-HIS-03)", () => {
  it("names each recorded operation and starts with the New Image base item", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    expect(doc.history.entries).toEqual([{ name: "New Image", applied: true }]);
    doc.addLayer();
    expect(doc.history.undoName).toBe("New Layer");
    doc.deleteActiveLayer();
    expect(doc.history.undoName).toBe("Delete Layer");
    doc.addLayer();
    doc.duplicateActiveLayer();
    expect(doc.history.undoName).toBe("Duplicate Layer");
    doc.flipActiveLayerHorizontal();
    expect(doc.history.undoName).toBe("Flip Horizontal");
    doc.flipActiveLayerVertical();
    expect(doc.history.undoName).toBe("Flip Vertical");
    doc.rotateActiveLayer180();
    expect(doc.history.undoName).toBe("Rotate 180°");
  });

  it("names property changes after the changed property, or Layer Properties for several", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.setActiveLayerProperties({ opacity: 10 });
    expect(doc.history.undoName).toBe("Layer Opacity");
    doc.setActiveLayerProperties({ visible: false });
    expect(doc.history.undoName).toBe("Layer Visible");
    doc.setActiveLayerProperties({ name: "Ink", blendMode: LayerBlendMode.multiply });
    expect(doc.history.undoName).toBe("Layer Properties");
    expect(doc.setActiveLayerProperties({ name: "Ink" })).toBe(false);
    expect(doc.history.undoName).toBe("Layer Properties");
  });

  it("names selection commands and records only real changes", () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    doc.selectAll();
    expect(doc.history.undoName).toBe("Select All");
    expect(doc.invertSelection()).toBe(true);
    expect(doc.history.undoName).toBe("Invert Selection");
    expect(doc.setSelectionQuality(doc.selection.quality)).toBe(false);
    const other = doc.selection.quality === "aliased" ? "antialiased" : "aliased";
    expect(doc.setSelectionQuality(other)).toBe(true);
    expect(doc.history.undoName).toBe("Change Selection Quality");
    doc.selectAll();
    doc.deselect();
    expect(doc.history.undoName).toBe("Deselect");
    const count = doc.history.entries.length;
    doc.deselect();
    expect(doc.history.entries.length).toBe(count);
  });

  it("names a resolution change Resize and ignores an unchanged resolution", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.setResolution(DEFAULT_RESOLUTION);
    expect(doc.history.entries).toHaveLength(1);
    doc.setResolution({ unit: "centimeter", x: 100, y: 100 });
    expect(doc.history.undoName).toBe("Resize");
  });
});

describe("undo and redo restore the document (DOC-HIS-01)", () => {
  it("undoes and redoes a layer addition", async () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    const added = doc.addLayer();
    expect(names(doc)).toEqual([BACKGROUND_LAYER_NAME, "Layer 2"]);
    await doc.history.undo();
    expect(names(doc)).toEqual([BACKGROUND_LAYER_NAME]);
    expect(doc.activeLayer).toBe(background(doc));
    await doc.history.redo();
    expect(doc.layers[1]).toBe(added);
    expect(doc.activeLayer).toBe(added);
  });

  it("restores a deleted layer with its pixels, properties and metadata", async () => {
    const doc = Document.createBlank({ width: 300, height: 300 });
    const top = doc.addLayer();
    top.pixels.setPixel(10, 20, RED);
    top.applyProperties({ name: "Sketch", opacity: 90 });
    top.metadata.set("note", "kept");
    doc.deleteActiveLayer();
    expect(doc.layerCount).toBe(1);

    await doc.history.undo();
    expect(doc.layers[1]).toBe(top);
    expect(top.name).toBe("Sketch");
    expect(top.opacity).toBe(90);
    expect(top.metadata.get("note")).toBe("kept");
    expect(top.pixels.getPixel(10, 20)).toEqual(RED);
    expect(doc.activeLayer).toBe(top);

    await doc.history.redo();
    expect(doc.layers).not.toContain(top);
    expect(doc.dirty).toBe(true);
  });

  it("undoes a duplicate and a merge, restoring both layers exactly", async () => {
    const doc = Document.createBlank({ width: 300, height: 300 });
    const base = background(doc);
    base.applyProperties({ name: "Base", opacity: 100, visible: false });
    const upper = doc.addLayer();
    upper.pixels.fill(rgba8(255, 0, 0, 128));
    upper.applyProperties({ blendMode: LayerBlendMode.multiply });

    doc.mergeActiveLayerDown();
    expect(doc.layerCount).toBe(1);
    await doc.history.undo();
    expect(doc.layers[0]).toBe(base);
    expect(doc.layers[1]).toBe(upper);
    expect(doc.layerCount).toBe(2);
    expect(base.name).toBe("Base");
    expect(base.pixels.getPixel(5, 5)).toEqual(WHITE);
    expect(upper.pixels.getPixel(5, 5)).toEqual(rgba8(255, 0, 0, 128));
    expect(upper.blendMode).toBe(LayerBlendMode.multiply);
    expect(doc.activeLayer).toBe(upper);

    const copy = doc.duplicateActiveLayer();
    await doc.history.undo();
    expect(doc.layers).not.toContain(copy);
    expect(doc.layerCount).toBe(2);
    expect(doc.layers[1]).toBe(upper);
  });

  it("undoes flips and rotations back to the original pixels", async () => {
    const doc = Document.createBlank({ width: 300, height: 300 });
    const layer = doc.addLayer();
    layer.pixels.setPixel(10, 20, RED);
    layer.pixels.setPixel(299, 299, BLUE);

    doc.rotateActiveLayer180();
    doc.flipActiveLayerVertical();
    await doc.history.undo();
    expect(layer.pixels.getPixel(289, 279)).toEqual(RED);
    await doc.history.undo();
    expect(layer.pixels.getPixel(10, 20)).toEqual(RED);
    expect(layer.pixels.getPixel(299, 299)).toEqual(BLUE);
    expect(layer.pixels.getPixel(289, 279)).toEqual(TRANSPARENT);
  });

  it("undoes layer moves and keeps the moved layer active", async () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.addLayer();
    doc.addLayer();
    doc.moveActiveLayerToBottom();
    expect(names(doc)).toEqual(["Layer 3", BACKGROUND_LAYER_NAME, "Layer 2"]);
    await doc.history.undo();
    expect(names(doc)).toEqual([BACKGROUND_LAYER_NAME, "Layer 2", "Layer 3"]);
    expect(doc.activeLayer?.name).toBe("Layer 3");
  });

  it("undoes property changes", async () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.setActiveLayerProperties({ opacity: 12, name: "Ink" });
    await doc.history.undo();
    expect(background(doc).opacity).toBe(255);
    expect(background(doc).name).toBe(BACKGROUND_LAYER_NAME);
  });

  it("undoes selection and resolution changes", async () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    doc.selectAll();
    await doc.history.undo();
    expect(doc.selection.isEmpty).toBe(true);
    doc.setResolution({ unit: "centimeter", x: 50, y: 50 });
    await doc.history.undo();
    expect(doc.resolution).toEqual(DEFAULT_RESOLUTION);
  });

  it("undoes a combined selection to the previous selection", async () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    doc.selectAll();
    const selectAll = doc.selection;
    doc.combineSelection([[0, 0, 4, 0, 4, 4, 0, 4]], "replace");
    expect(doc.selection.area()).toBe(16);
    await doc.history.undo();
    expect(doc.selection).toBe(selectAll);
    expect(doc.selection).toBeInstanceOf(Selection);
  });

  it("undoes everything back to the base item and not past it", async () => {
    const doc = Document.createBlank({ width: 300, height: 300 });
    const top = doc.addLayer();
    doc.editLayerPixels("Paint", top, rect(1, 1, 1, 1), (pixels) => {
      pixels.setPixel(1, 1, RED);
    });
    doc.duplicateActiveLayer();
    doc.mergeActiveLayerDown();
    doc.flipActiveLayerHorizontal();
    doc.setActiveLayerProperties({ opacity: 1 });
    await doc.history.seek(1);
    expect(names(doc)).toEqual([BACKGROUND_LAYER_NAME]);
    expect(background(doc).opacity).toBe(255);
    expect(background(doc).pixels.getPixel(0, 0)).toEqual(WHITE);
    expect(await doc.history.undo()).toBe(false);

    await doc.history.seek(doc.history.entries.length);
    expect(doc.layerCount).toBe(2);
    expect(doc.layers[1]?.pixels.getPixel(298, 1)).toEqual(RED);
    expect(doc.layers[1]?.pixels.getPixel(0, 0)).toEqual(TRANSPARENT);
  });

  it("reads undo data back from storage after the cache has evicted it", async () => {
    const { doc, spill, storage } = documentWithSpill({ cacheBytes: 0 });
    const top = doc.addLayer();
    top.pixels.fill(RED, rect(0, 0, 300, 300));
    doc.flipActiveLayerHorizontal();
    await spill.flush();
    expect(spill.cachedBytes).toBe(0);
    expect(storage.size).toBeGreaterThan(0);

    await doc.history.undo();
    expect(top.pixels.getPixel(299, 299)).toEqual(RED);
    await doc.history.redo();
    expect(top.pixels.getPixel(0, 0)).toEqual(RED);
  });

  it("releases the spilled data of discarded items", async () => {
    const { doc, spill, storage } = documentWithSpill();
    doc.addLayer();
    doc.flipActiveLayerHorizontal();
    expect(spill.liveCount).toBe(3);
    await doc.history.undo();
    await doc.history.undo();
    expect(spill.liveCount).toBe(3);
    doc.addLayer();
    await spill.flush();
    expect(spill.liveCount).toBe(1);
    expect(storage.size).toBe(1);
  });

  it("releases every item's spilled data on dispose", async () => {
    const { doc, spill, storage } = documentWithSpill();
    doc.flipActiveLayerHorizontal();
    expect(spill.liveCount).toBe(2);
    doc.dispose();
    await spill.flush();
    expect(spill.liveCount).toBe(0);
    expect(storage.size).toBe(0);
  });

  it("leaves the document unchanged when an operation fails, and spills nothing for it", () => {
    const accountant = new MemoryAccountant(4 * TILE_BYTES);
    const { doc, spill } = documentWithSpill({ accountant });
    const live = spill.liveCount;
    expect(() => doc.duplicateActiveLayer()).toThrow();
    expect(doc.layerCount).toBe(1);
    expect(spill.liveCount).toBe(live);
    expect(doc.history.entries).toHaveLength(1);
  });
});

describe("dirty state follows the saved position (DOC-DOC-06)", () => {
  it("is clean on creation, dirty after a change, and clean again after undoing to the save", async () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    expect(doc.dirty).toBe(false);
    doc.addLayer();
    expect(doc.dirty).toBe(true);
    await doc.history.undo();
    expect(doc.dirty).toBe(false);
    await doc.history.redo();
    expect(doc.dirty).toBe(true);
  });

  it("is clean after a save and dirty again after an undo past it", async () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.addLayer();
    doc.markClean();
    expect(doc.dirty).toBe(false);
    await doc.history.undo();
    expect(doc.dirty).toBe(true);
    await doc.history.undo();
    expect(doc.dirty).toBe(true);
  });

  it("stays dirty when a new change discards the saved item", async () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.addLayer();
    doc.markClean();
    await doc.history.undo();
    doc.addLayer();
    await doc.history.undo();
    expect(doc.dirty).toBe(true);
    doc.markClean();
    expect(doc.dirty).toBe(false);
  });

  it("notifies subscribers on undo and redo", async () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.addLayer();
    let calls = 0;
    doc.subscribe(() => {
      calls++;
    });
    await doc.history.undo();
    await doc.history.redo();
    expect(calls).toBe(2);
  });
});

describe("changes during an undo", () => {
  it("refuses new changes without touching the document", async () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.addLayer();
    const pending = doc.history.undo();
    expect(() => doc.addLayer()).toThrow("busy");
    expect(() => doc.setActiveLayerProperties({ opacity: 1 })).toThrow("busy");
    expect(() => doc.selectAll()).toThrow("busy");
    await pending;
    expect(doc.layerCount).toBe(1);
    expect(doc.activeLayer?.opacity).toBe(255);
    expect(doc.history.entries.map((entry) => entry.applied)).toEqual([true, false]);
  });
});

describe("tile-level pixel edits (ARC-04-06, DOC-HIS-02)", () => {
  it("records only the tiles that cover the edited area, and undoes and redoes them", async () => {
    const { doc, spill } = documentWithSpill({ width: 600, height: 300 });
    const layer = background(doc);
    const area = rect(300, 0, 10, 10);
    doc.editLayerPixels("Paint Brush", layer, area, (pixels) => {
      pixels.fill(RED, area);
    });
    expect(doc.history.undoName).toBe("Paint Brush");
    expect(layer.pixels.getPixel(305, 5)).toEqual(RED);
    expect(doc.dirty).toBe(true);

    await doc.history.undo();
    expect(layer.pixels.getPixel(305, 5)).toEqual(WHITE);
    expect(layer.pixels.getPixel(0, 0)).toEqual(WHITE);
    expect(doc.dirty).toBe(false);

    await doc.history.redo();
    expect(layer.pixels.getPixel(305, 5)).toEqual(RED);
    expect(layer.pixels.getPixel(0, 0)).toEqual(WHITE);
    await spill.flush();
  });

  it("does not record a failed edit", () => {
    const { doc, spill } = documentWithSpill();
    const live = spill.liveCount;
    expect(() =>
      doc.editLayerPixels("Broken", background(doc), rect(0, 0, 4, 4), () => {
        throw new Error("brush failed");
      }),
    ).toThrow("brush failed");
    expect(doc.history.entries).toHaveLength(1);
    expect(spill.liveCount).toBe(live);
  });

  it("refuses a layer that is not in the document", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    const stranger = Document.createBlank({ width: 4, height: 4 }).layers[0];
    if (!stranger) throw new Error("missing background");
    expect(() => doc.editLayerPixels("x", stranger, rect(0, 0, 1, 1), () => {})).toThrow(
      RangeError,
    );
  });

  it("uses the layer's current store, so it still works after a whole-layer change", async () => {
    const doc = Document.createBlank({ width: 300, height: 300 });
    const layer = background(doc);
    doc.editLayerPixels("Paint", layer, rect(0, 0, 4, 4), (pixels) => {
      pixels.fill(BLACK, rect(0, 0, 4, 4));
    });
    doc.flipActiveLayerHorizontal();
    await doc.history.undo();
    await doc.history.undo();
    expect(layer.pixels.getPixel(0, 0)).toEqual(WHITE);
    await doc.history.redo();
    expect(layer.pixels.getPixel(0, 0)).toEqual(BLACK);
  });
});
