import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it } from "vitest";
import { LayerBlendMode } from "./blend-mode";
import type { DocumentCheckpoint } from "./checkpoint";
import { rgba8, WHITE } from "./color";
import { Document, isUntouchedBlankCheckpoint } from "./document";
import { rect } from "./geometry";
import { Surface } from "./surface";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

/** A checkpoint that went through JSON, as the session store writes it. */
function throughJson(checkpoint: DocumentCheckpoint): DocumentCheckpoint {
  const manifest = JSON.parse(
    JSON.stringify(checkpoint.manifest),
  ) as DocumentCheckpoint["manifest"];
  return { manifest, blobs: checkpoint.blobs };
}

/** The rule on the document, on its checkpoint, and on the document rebuilt from that checkpoint. */
async function untouched(doc: Document): Promise<[boolean, boolean, boolean]> {
  const checkpoint = throughJson(await doc.checkpoint());
  const restored = await Document.fromCheckpoint(checkpoint);
  return [
    doc.untouchedBlank,
    isUntouchedBlankCheckpoint(checkpoint.manifest),
    restored.untouchedBlank,
  ];
}

function draw(doc: Document): void {
  const layer = doc.activeLayer;
  if (layer === undefined) throw new Error("no layer");
  doc.editLayerPixels("Brush", layer, rect(0, 0, 2, 2), (pixels) => {
    pixels.fill(rgba8(255, 0, 0), rect(0, 0, 2, 2));
  });
}

describe("Document.untouchedBlank (SET-LIFE-11)", () => {
  it("is true for a new blank image", async () => {
    expect(await untouched(Document.createBlank({ width: 8, height: 6 }))).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("stays true after selection steps", async () => {
    const doc = Document.createBlank({ width: 8, height: 6 });
    doc.selectAll();
    doc.invertSelection();
    doc.selectAll();
    doc.setSelectionQuality("aliased");
    expect(doc.dirty).toBe(true);
    expect(await untouched(doc)).toEqual([true, true, true]);
  });

  it("is true again once every edit is undone", async () => {
    const doc = Document.createBlank({ width: 8, height: 6 });
    draw(doc);
    doc.addLayer();
    await doc.history.undo();
    await doc.history.undo();
    expect(doc.history.canRedo).toBe(true);
    expect(await untouched(doc)).toEqual([true, true, true]);
  });

  it("is true after a layer property change that was put back", async () => {
    const doc = Document.createBlank({ width: 8, height: 6 });
    doc.setActiveLayerProperties({ visible: false });
    doc.setActiveLayerProperties({ visible: true });
    expect(await untouched(doc)).toEqual([true, true, true]);
  });

  it("is false after a drawing, even of white", async () => {
    const doc = Document.createBlank({ width: 8, height: 6 });
    draw(doc);
    expect(await untouched(doc)).toEqual([false, false, false]);
    const white = Document.createBlank({ width: 8, height: 6 });
    const layer = white.activeLayer;
    if (layer === undefined) throw new Error("no layer");
    white.editLayerPixels("Brush", layer, rect(0, 0, 2, 2), (pixels) => {
      pixels.fill(WHITE, rect(0, 0, 2, 2));
    });
    expect(white.untouchedBlank).toBe(false);
  });

  it("is false with an added layer, changed properties or another resolution", async () => {
    const layered = Document.createBlank({ width: 8, height: 6 });
    layered.addLayer();
    expect(await untouched(layered)).toEqual([false, false, false]);

    const hidden = Document.createBlank({ width: 8, height: 6 });
    hidden.setActiveLayerProperties({ opacity: 100 });
    expect(await untouched(hidden)).toEqual([false, false, false]);

    const dense = Document.createBlank({
      width: 8,
      height: 6,
      resolution: { unit: "inch", x: 300, y: 300 },
    });
    expect(await untouched(dense)).toEqual([false, false, false]);
  });

  it("is false after an image-wide change such as a flip", async () => {
    const doc = Document.createBlank({ width: 8, height: 6 });
    doc.flipImage("horizontal");
    expect(await untouched(doc)).toEqual([false, false, false]);
  });

  it("is false for an opened file, even a white one", async () => {
    const pixels = new Surface(8, 6);
    pixels.fill(WHITE);
    const doc = Document.fromLayers(8, 6, [
      {
        pixels,
        name: "Background",
        visible: true,
        opacity: 255,
        blendMode: LayerBlendMode.normal,
        isBackground: true,
      },
    ]);
    expect(await untouched(doc)).toEqual([false, false, false]);
  });
});
