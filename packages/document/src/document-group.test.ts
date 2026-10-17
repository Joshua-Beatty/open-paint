import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it } from "vitest";
import type { DocumentCheckpoint } from "./checkpoint";
import { rgba8 } from "./color";
import { Document } from "./document";
import { rect } from "./geometry";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const RED = rgba8(255, 0, 0);

/** Adds a "Tint" layer with a red square, as one step group. */
function addTint(doc: Document): void {
  doc.group("Add tint", () => {
    const layer = doc.addLayer();
    doc.setActiveLayerProperties({ name: "Tint", opacity: 100 });
    doc.editLayerPixels("Paint", layer, rect(0, 0, 4, 4), (pixels) => {
      pixels.fill(RED, rect(0, 0, 4, 4));
    });
  });
}

function throughJson(checkpoint: DocumentCheckpoint): DocumentCheckpoint {
  const manifest = JSON.parse(
    JSON.stringify(checkpoint.manifest),
  ) as DocumentCheckpoint["manifest"];
  return { manifest, blobs: checkpoint.blobs };
}

describe("Document step groups (DOC-HIS-01)", () => {
  it("makes several edits one undoable entry and restores each one", async () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    addTint(doc);

    expect(doc.history.entries).toHaveLength(2);
    expect(doc.history.entries.at(-1)).toEqual({ name: "Add tint", applied: true });

    expect(await doc.history.undo()).toBe(true);
    expect(doc.layers.map((layer) => layer.name)).toEqual(["Background"]);
    expect(doc.dirty).toBe(false);

    expect(await doc.history.redo()).toBe(true);
    expect(doc.dirty).toBe(true);
    expect(doc.layers.map((layer) => layer.name)).toEqual(["Background", "Tint"]);
    expect(Array.from(doc.layers[1]?.pixels.readRegion(rect(0, 0, 1, 1)).data ?? [])).toEqual([
      255, 0, 0, 255,
    ]);
  });

  it("returns the action result and records nothing for a no-op action", () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    const changed = doc.group("No change", () => doc.setActiveLayerProperties({ opacity: 255 }));
    expect(changed).toBe(false);
    expect(doc.history.entries).toHaveLength(1);
    expect(doc.dirty).toBe(false);
  });

  it("keeps group items through a checkpoint, with the same undo and redo", async () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    addTint(doc);
    const restored = await Document.fromCheckpoint(throughJson(await doc.checkpoint()));

    expect(restored.history.entries).toEqual(doc.history.entries);
    expect(await restored.history.undo()).toBe(true);
    expect(restored.layers.map((layer) => layer.name)).toEqual(["Background"]);
    expect(await restored.history.redo()).toBe(true);
    expect(restored.layers.map((layer) => layer.name)).toEqual(["Background", "Tint"]);
    expect(restored.composite().data).toEqual(doc.composite().data);
  });
});
