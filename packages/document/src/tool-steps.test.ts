/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it } from "vitest";
import type { DocumentCheckpoint } from "./checkpoint";
import { Document } from "./document";
import { rect } from "./geometry";
import type { ToolStep } from "./history/history";
import type { Layer } from "./layer";
import { Selection } from "./selection";
import { rectPolygon } from "./selection-polygons";
import { Surface } from "./surface";
import { documentThumbnail, ThumbnailRenderer } from "./thumbnail";
import { TILE_SIZE } from "./tiled-store";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const RED = { r: 255, g: 0, b: 0, a: 255 };
const BLUE = { r: 0, g: 0, b: 255, a: 255 };
const WHITE = { r: 255, g: 255, b: 255, a: 255 };

function step(session: object): ToolStep {
  return { tool: "shapes", layer: 0, kind: "edit", session, before: undefined, after: undefined };
}

describe("Document.stateBefore (TL-FRAME-01 re-entry)", () => {
  it("gives the tiles and selection from before a run of items, from their undo data", async () => {
    const doc = Document.createBlank({ width: 600, height: 300 });
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("no layer");
    doc.replaceSelection(new Selection([rectPolygon(rect(0, 0, 50, 50))]), "select");
    const selected = doc.selection;
    const session = {};
    doc.history.withStep(step(session), () =>
      doc.editLayerPixels("Draw", layer, rect(10, 10, 20, 20), (pixels) =>
        pixels.fill(RED, rect(10, 10, 20, 20)),
      ),
    );
    doc.history.withStep(step(session), () =>
      doc.editLayerPixels("Edit", layer, rect(10, 10, 300, 20), (pixels) =>
        pixels.fill(BLUE, rect(10, 10, 300, 20)),
      ),
    );
    const items = doc.history.appliedCommands.slice(-2);
    const { tiles, selection } = await doc.stateBefore(layer, items);
    expect(selection).toBe(selected);
    // The edit reached the second tile column, which only the newer item covers.
    expect([...tiles.keys()].sort()).toEqual([0, 1]);
    for (const tile of tiles.values()) {
      expect(tile).not.toBeNull();
      expect(tile?.width).toBe(TILE_SIZE);
    }
    expect(tiles.get(0)?.getPixel(15, 15)).toEqual(WHITE);
    expect(tiles.get(1)?.getPixel(10, 15)).toEqual(WHITE);
    // Nothing changed in the document.
    expect(layer.pixels.getPixel(15, 15)).toEqual(BLUE);
  });
});

describe("Document change guard (TL-FRAME-01: commands finish a pending result)", () => {
  it("runs before recorded changes and copies, but not inside a tool's own step or a preview", () => {
    const doc = Document.createBlank({ width: 40, height: 40 });
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("no layer");
    const calls: string[] = [];
    let label = "";
    const stop = doc.setChangeGuard(() => {
      calls.push(label);
      // A guard that records (a Finish) is not guarded again.
      if (label === "nested") doc.selectAll();
    });
    label = "select";
    doc.selectAll();
    label = "copy";
    doc.copyPixels(false);
    label = "tool";
    doc.history.withStep(step({}), () =>
      doc.editLayerPixels("Draw", layer, rect(0, 0, 4, 4), () => {}),
    );
    label = "preview";
    doc.previewLayerPixels(layer, () => {});
    doc.previewSelection(new Selection());
    label = "nested";
    doc.addLayer();
    stop();
    label = "after";
    doc.deselect();
    expect(calls).toEqual(["select", "copy", "nested"]);
  });
});

describe("tool results drawn over a layer (TL-FRAME-01, phase 2)", () => {
  const all = (doc: Document) => {
    const layer = doc.activeLayer as Layer;
    return [...layer.pixels.readRegion(layer.pixels.bounds).data];
  };
  const finish = (doc: Document, renders: { count: number }) => {
    const layer = doc.activeLayer as Layer;
    const write = (pixels: Layer["pixels"]) => pixels.fill(RED, rect(10, 10, 300, 20));
    doc.editLayerPixelsRendered("Finish", layer, [rect(10, 10, 300, 20)], write, async () => {
      renders.count += 1;
      return write;
    });
  };

  it("keeps only the pixels a Finish overwrote, and draws it again on redo", async () => {
    const doc = Document.createBlank({ width: 600, height: 100 });
    const before = all(doc);
    const renders = { count: 0 };
    finish(doc, renders);
    const after = all(doc);
    await doc.history.undo();
    expect(all(doc)).toEqual(before);
    await doc.history.redo();
    expect(renders.count).toBe(1);
    expect(all(doc)).toEqual(after);
  });

  it("checkpoints a Finish and state-only steps; a restored Finish undoes and redoes, an undone one is left out", async () => {
    const doc = Document.createBlank({ width: 600, height: 100 });
    const renders = { count: 0 };
    doc.history.recordStep("Draw", step({}));
    finish(doc, renders);
    const after = all(doc);
    const restored = await Document.fromCheckpoint(throughJson(await doc.checkpoint()));
    expect(restored.history.entries.map((entry) => entry.name)).toEqual([
      "New Image",
      "Draw",
      "Finish",
    ]);
    await restored.history.undo();
    expect(all(restored)).not.toEqual(after);
    await restored.history.redo();
    expect(all(restored)).toEqual(after);
    await restored.history.undo();
    await restored.history.undo();
    expect(restored.history.canUndo).toBe(false);

    await doc.history.undo();
    const undone = await Document.fromCheckpoint(throughJson(await doc.checkpoint()));
    expect(undone.history.entries.map((entry) => entry.name)).toEqual(["New Image", "Draw"]);
    expect(undone.history.canRedo).toBe(false);
  });

  it("composites and thumbnails a layer with its overlay, which leaves its pixels as they are", async () => {
    const doc = Document.createBlank({ width: 300, height: 40 });
    const layer = doc.activeLayer as Layer;
    const patch = new Surface(20, 10);
    patch.fill(BLUE);
    const renderer = new ThumbnailRenderer(64);
    const pause = async () => {};
    const plain = await renderer.layer(layer, pause);
    doc.setLayerOverlay(layer, { patches: [{ area: rect(260, 5, 20, 10), output: patch }] });
    expect(doc.compositeArea(rect(265, 8, 1, 1)).getPixel(0, 0)).toEqual(BLUE);
    expect(layer.pixels.getPixel(265, 8)).toEqual(WHITE);
    const shown = await renderer.layer(layer, pause);
    expect(shown).not.toEqual(plain);
    layer.pixels.fill(BLUE, rect(260, 5, 20, 10));
    doc.setLayerOverlay(layer, undefined);
    expect(await renderer.layer(layer, pause)).toEqual(shown);
    expect(await renderer.document(doc, pause)).toEqual(documentThumbnail(doc, 64));
  });
});

function throughJson(checkpoint: DocumentCheckpoint): DocumentCheckpoint {
  const manifest = JSON.parse(
    JSON.stringify(checkpoint.manifest),
  ) as DocumentCheckpoint["manifest"];
  return { manifest, blobs: checkpoint.blobs };
}
