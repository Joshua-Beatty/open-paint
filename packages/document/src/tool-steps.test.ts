/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it } from "vitest";
import { Document } from "./document";
import { rect } from "./geometry";
import type { ToolStep } from "./history/history";
import { Selection } from "./selection";
import { rectPolygon } from "./selection-polygons";
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
