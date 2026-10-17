import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CheckpointError, type DocumentCheckpoint } from "./checkpoint";
import { rgba8 } from "./color";
import { Document } from "./document";
import { rect } from "./geometry";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const RED = rgba8(255, 0, 0);
const BLUE = rgba8(0, 0, 255, 128);

/** A checkpoint that went through JSON, as the session store writes it. */
function throughJson(checkpoint: DocumentCheckpoint): DocumentCheckpoint {
  const manifest = JSON.parse(
    JSON.stringify(checkpoint.manifest),
  ) as DocumentCheckpoint["manifest"];
  return { manifest, blobs: checkpoint.blobs };
}

function editedDocument(): Document {
  const doc = Document.createBlank({ width: 16, height: 12 });
  const ink = doc.addLayer();
  doc.setActiveLayerProperties({ name: "Ink", opacity: 200 });
  doc.editLayerPixels("Brush", ink, rect(0, 0, 8, 8), (pixels) => {
    pixels.fill(RED, rect(0, 0, 8, 8));
  });
  doc.editLayerPixels("Brush", ink, rect(4, 4, 6, 6), (pixels) => {
    pixels.fill(BLUE, rect(4, 4, 6, 6));
  });
  doc.selectAll();
  return doc;
}

describe("Document checkpoints (WEB-MEM-05)", () => {
  it("restores layers, selection, size and history from JSON alone", async () => {
    const doc = editedDocument();
    const restored = await Document.fromCheckpoint(throughJson(await doc.checkpoint()));

    expect(restored.width).toBe(doc.width);
    expect(restored.height).toBe(doc.height);
    expect(restored.layers.map((layer) => layer.name)).toEqual(["Background", "Ink"]);
    expect(restored.layers[1]?.opacity).toBe(200);
    expect(restored.activeLayer?.id).toBe(doc.activeLayer?.id);
    expect(restored.selection.bounds()).toEqual(doc.selection.bounds());
    expect(restored.composite().data).toEqual(doc.composite().data);
    expect(restored.history.entries).toEqual(doc.history.entries);
  });

  it("captures only the tile rows an edit touched (L2)", async () => {
    const doc = Document.createBlank({ width: 600, height: 800 });
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("no active layer");
    const first = await doc.checkpoint();
    const rows = [...first.blobs.keys()].filter((name) => name.startsWith("layer-"));
    expect(rows).toHaveLength(4);
    doc.editLayerPixels("Brush", layer, rect(300, 520, 4, 4), (pixels) => {
      pixels.fill(RED, rect(300, 520, 4, 4));
    });
    const second = await doc.checkpoint(new Set(first.blobs.keys()));
    expect([...second.blobs.keys()].filter((name) => name.startsWith("layer-"))).toEqual([
      expect.stringMatching(/^layer-\d+-r2-v\d+$/),
    ]);
  });

  it("copies the pixels between pauses, and again any row that changed meanwhile (L5)", async () => {
    const doc = Document.createBlank({ width: 600, height: 800 });
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("no active layer");
    // Every row takes "10 ms", so the checkpoint pauses after each one.
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => (clock += 10));
    let pauses = 0;
    const pending = doc.checkpoint(new Set(), async () => {
      pauses += 1;
      if (pauses === 1) {
        doc.editLayerPixels("Brush", layer, rect(0, 0, 4, 4), (pixels) => {
          pixels.fill(RED, rect(0, 0, 4, 4));
        });
      }
    });
    const checkpoint = await pending;
    now.mockRestore();
    expect(pauses).toBe(4);
    const restored = await Document.fromCheckpoint(throughJson(checkpoint));
    expect(firstDifference(restored.composite().data, doc.composite().data)).toBe(-1);
    expect(restored.activeLayer?.pixels.getPixel(1, 1)).toEqual(RED);
  });

  it("leaves out the blobs the caller holds, and names changed content anew (L2)", async () => {
    const doc = editedDocument();
    const first = await doc.checkpoint();
    const held = new Map(first.blobs);
    expect(first.reused).toEqual([]);

    const ink = doc.activeLayer;
    if (ink === undefined) throw new Error("no active layer");
    doc.editLayerPixels("Brush", ink, rect(0, 0, 2, 2), (pixels) => {
      pixels.fill(BLUE, rect(0, 0, 2, 2));
    });
    const second = await doc.checkpoint(new Set(held.keys()));
    // Only the edited layer and the new history item's patches are captured.
    const fresh = [...second.blobs.keys()];
    expect(fresh.filter((name) => name.startsWith("layer-"))).toHaveLength(1);
    expect(fresh.every((name) => !held.has(name))).toBe(true);
    expect(second.reused?.length).toBeGreaterThan(0);
    expect(second.reused?.every((name) => held.has(name))).toBe(true);

    for (const [name, data] of second.blobs) held.set(name, data);
    const restored = await Document.fromCheckpoint(
      throughJson({ manifest: second.manifest, blobs: held }),
    );
    expect(restored.composite().data).toEqual(doc.composite().data);
    expect(restored.history.entries).toEqual(doc.history.entries);
    await restored.history.undo();
    await doc.history.undo();
    expect(restored.composite().data).toEqual(doc.composite().data);
  });

  it("keeps the dirty state and undoes to the same pixels as the original", async () => {
    const doc = editedDocument();
    const restored = await Document.fromCheckpoint(throughJson(await doc.checkpoint()));
    expect(restored.dirty).toBe(true);

    await doc.history.undo();
    await restored.history.undo();
    await doc.history.undo();
    await restored.history.undo();
    expect(restored.composite().data).toEqual(doc.composite().data);
    expect(restored.layers.map((layer) => layer.name)).toEqual(
      doc.layers.map((layer) => layer.name),
    );
    expect(restored.dirty).toBe(doc.dirty);
  });

  it("is clean again when undo reaches the saved position", async () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    const layer = doc.layers[0];
    if (layer === undefined) throw new Error("no layer");
    doc.editLayerPixels("Erase", layer, rect(0, 0, 8, 8), (pixels) => {
      pixels.fill(RED, rect(0, 0, 8, 8));
    });
    const restored = await Document.fromCheckpoint(throughJson(await doc.checkpoint()));
    expect(restored.dirty).toBe(true);
    await restored.history.undo();
    expect(restored.dirty).toBe(false);
  });

  it("keeps a clean document clean until it changes", async () => {
    const doc = editedDocument();
    doc.markClean();
    const restored = await Document.fromCheckpoint(throughJson(await doc.checkpoint()));
    expect(restored.dirty).toBe(false);

    await restored.history.undo();
    expect(restored.dirty).toBe(true);
  });

  it("brings back a deleted layer with its pixels when undoing the delete", async () => {
    const doc = editedDocument();
    doc.deleteActiveLayer();
    const restored = await Document.fromCheckpoint(throughJson(await doc.checkpoint()));
    expect(restored.layers.map((layer) => layer.name)).toEqual(["Background"]);

    await doc.history.undo();
    await restored.history.undo();
    expect(restored.layers.map((layer) => layer.name)).toEqual(["Background", "Ink"]);
    expect(restored.composite().data).toEqual(doc.composite().data);

    await doc.history.undo();
    await restored.history.undo();
    expect(restored.composite().data).toEqual(doc.composite().data);
  });

  it("keeps the layer ids, so new layers do not collide with restored ones", async () => {
    const doc = editedDocument();
    const restored = await Document.fromCheckpoint(throughJson(await doc.checkpoint()));
    restored.addLayer();
    const ids = restored.layers.map((layer) => layer.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps metadata and unknown format keys", async () => {
    const doc = editedDocument();
    doc.metadata.user.set("note", "draft");
    doc.metadata.exif.set("Make", new Uint8Array([1, 2, 3]));
    doc.metadata.xmlHeader = "<?xml?>";
    const restored = await Document.fromCheckpoint(throughJson(await doc.checkpoint()));
    expect(restored.metadata.user.get("note")).toBe("draft");
    expect(restored.metadata.exif.get("Make")).toEqual(new Uint8Array([1, 2, 3]));
    expect(restored.metadata.xmlHeader).toBe("<?xml?>");
  });

  it("does not block previews, edits or undo while it finishes, and keeps the state it started with", async () => {
    const doc = editedDocument();
    const ink = doc.activeLayer;
    if (ink === undefined) throw new Error("no layer");
    const expected = doc.composite().data;
    const entries = doc.history.entries;
    const pending = doc.checkpoint();

    // A live preview and a recorded edit, as a stroke makes them, right after the call.
    doc.previewLayerPixels(ink, (pixels) => pixels.fill(RED, rect(10, 0, 2, 2)));
    doc.restoreLayerPixels(ink, (pixels) => pixels.fill(rgba8(0, 0, 0, 0), rect(10, 0, 2, 2)));
    doc.editLayerPixels("Brush", ink, rect(12, 0, 2, 2), (pixels) => {
      pixels.fill(RED, rect(12, 0, 2, 2));
    });
    expect(await doc.history.undo()).toBe(true);

    const restored = await Document.fromCheckpoint(throughJson(await pending));
    expect(restored.composite().data).toEqual(expected);
    expect(restored.history.entries).toEqual(entries);
  });

  it("still reads history data that an edit releases while it finishes", async () => {
    const doc = editedDocument();
    const ink = doc.activeLayer;
    if (ink === undefined) throw new Error("no layer");
    await doc.history.undo();
    await doc.history.undo();
    const pending = doc.checkpoint();
    // A new edit drops the undone items and frees their spilled data.
    doc.editLayerPixels("Brush", ink, rect(12, 0, 2, 2), (pixels) => {
      pixels.fill(RED, rect(12, 0, 2, 2));
    });

    const restored = await Document.fromCheckpoint(throughJson(await pending));
    await restored.history.redo();
    await restored.history.redo();
    expect(restored.composite().data).toEqual(editedDocument().composite().data);
  });

  it("refuses a checkpoint this version did not write", async () => {
    const checkpoint = await editedDocument().checkpoint();
    const foreign = { ...checkpoint, manifest: { ...checkpoint.manifest, version: 2 } };
    await expect(Document.fromCheckpoint(foreign as unknown as DocumentCheckpoint)).rejects.toThrow(
      CheckpointError,
    );
  });

  it("names the blob that a damaged checkpoint lacks", async () => {
    const checkpoint = await editedDocument().checkpoint();
    const damaged = { manifest: checkpoint.manifest, blobs: new Map<string, Uint8Array>() };
    await expect(Document.fromCheckpoint(damaged)).rejects.toThrow("missing layer-");
  });
});

/** The first index where two byte arrays differ, or -1; far faster than a deep equal on images. */
function firstDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}
