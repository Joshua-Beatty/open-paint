/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it } from "vitest";
import { translationAffine } from "./affine";
import type { ClipboardImage } from "./clipboard";
import { rgba8, WHITE } from "./color";
import { placeByCoverage } from "./coverage-place";
import { Document } from "./document";
import { rect } from "./geometry";
import type { Layer } from "./layer";
import { MemoryAccountant, OutOfMemoryError } from "./memory";
import { remainingAfterLift } from "./pixel-float";
import type { TransformResampler } from "./pixel-transform";
import { Selection } from "./selection";
import { rectPolygon } from "./selection-polygons";
import { Surface } from "./surface";
import { TiledPixelStore } from "./tiled-store";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const RED = rgba8(255, 0, 0);
const BLUE = rgba8(0, 0, 255);

/** A 16 x 16 white document with a red 4 x 4 block at (2, 2) and a selection over it. */
function selectedDocument(): { doc: Document; layer: Layer } {
  const doc = Document.createBlank({ width: 16, height: 16 });
  const layer = doc.activeLayer;
  if (layer === undefined) throw new Error("no layer");
  const red = new Surface(4, 4);
  red.fill(RED);
  doc.editLayerPixels("paint", layer, rect(2, 2, 4, 4), (pixels) => {
    pixels.writeRegion(red, 2, 2);
  });
  doc.replaceSelection(new Selection([rectPolygon(rect(2, 2, 4, 4))]), "select");
  return { doc, layer };
}

function pixelOf(layer: Layer, x: number, y: number) {
  return layer.pixels.getPixel(x, y);
}

describe("Move Selected Pixels session (TL-MOVE-PIX-01, TL-FRAME-01)", () => {
  it("lifts the selected pixels and draws them at the new place as a preview", () => {
    const { doc, layer } = selectedDocument();
    const session = doc.liftSelectedPixels();
    if (session === undefined) throw new Error("nothing lifted");
    expect(session.live).toBe(true);
    expect(session.pending).toBe(false);
    expect(session.preview(translationAffine(2 + 6, 2))).toBe(true);
    expect(pixelOf(layer, 2, 2).a).toBe(0);
    expect(pixelOf(layer, 8, 2)).toEqual(RED);
    expect(pixelOf(layer, 0, 0)).toEqual(WHITE);
    expect(session.pending).toBe(true);
  });

  it("redraws only where the content was and is during a drag, matching a single move", () => {
    /** A wide image with a soft-edged block, selected with an antialiased edge, and its session. */
    const make = () => {
      const doc = Document.createBlank({ width: 600, height: 40 });
      const layer = doc.activeLayer as Layer;
      const block = new Surface(6, 6);
      block.fill(rgba8(200, 30, 10, 180));
      block.fill(RED, rect(1, 1, 4, 4));
      doc.editLayerPixels("paint", layer, rect(2, 2, 6, 6), (pixels) => {
        pixels.writeRegion(block, 2, 2);
      });
      doc.replaceSelection(new Selection([[2, 2, 7.5, 2, 7.5, 8, 2, 8]]), "select");
      const session = doc.liftSelectedPixels();
      if (session === undefined) throw new Error("nothing lifted");
      return { doc, layer, session };
    };
    const whole = (layer: Layer) => [...layer.pixels.readRegion(layer.pixels.bounds).data];
    const { layer, session } = make();
    const steps: [number, number][] = [
      [40, 3],
      [300, 20],
      [301, 21],
      [580, 30],
    ];
    let previous = 2;
    for (const [x, y] of steps) {
      const written: number[] = [];
      const write = layer.pixels.writeRegion.bind(layer.pixels);
      layer.pixels.writeRegion = (surface, dx, dy) => {
        written.push(surface.width);
        return write(surface, dx, dy);
      };
      session.preview(translationAffine(x, y));
      layer.pixels.writeRegion = write;
      // The area has grown to span the image, but each step writes its two places only.
      expect(Math.max(...written)).toBeLessThanOrEqual(Math.abs(x - previous) + 6);
      previous = x;
      const single = make();
      single.session.preview(translationAffine(x, y));
      expect(whole(layer)).toEqual(whole(single.layer));
    }
    // A stamp, a move away and a cancel come back to the committed state exactly.
    const committed = make();
    session.stamp();
    session.preview(translationAffine(100, 10));
    session.cancel();
    expect(whole(layer)).toEqual(whole(committed.layer));
  });

  it("records a committed move as one history item and undoes it to the original pixels", async () => {
    const { doc, layer } = selectedDocument();
    const session = doc.liftSelectedPixels();
    if (session === undefined) throw new Error("nothing lifted");
    session.preview(translationAffine(2 + 6, 2));
    expect(session.commit("history.movePixels")).toBe(true);
    expect(doc.history.undoName).toBe("history.movePixels");
    expect(doc.dirty).toBe(true);
    expect(pixelOf(layer, 8, 2)).toEqual(RED);
    expect(doc.selection.bounds()).toEqual(rect(8, 2, 4, 4));

    await doc.history.undo();
    expect(pixelOf(layer, 2, 2)).toEqual(RED);
    expect(pixelOf(layer, 8, 2)).toEqual(WHITE);
    expect(doc.selection.bounds()).toEqual(rect(2, 2, 4, 4));

    await doc.history.redo();
    expect(pixelOf(layer, 8, 2)).toEqual(RED);
    expect(pixelOf(layer, 2, 2).a).toBe(0);
  });

  it("finishes without a move and leaves antialiased selection edges exactly as they were", () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    const layer = doc.activeLayer as Layer;
    const red = new Surface(8, 8);
    red.fill(RED);
    doc.editLayerPixels("paint", layer, rect(0, 0, 8, 8), (pixels) => {
      pixels.writeRegion(red, 0, 0);
    });
    doc.replaceSelection(new Selection([[2.5, 0, 8, 0, 8, 8, 2.5, 8]]), "select");
    const before = layer.pixels.readRegion(rect(0, 0, 8, 8)).data.slice();
    const session = doc.liftSelectedPixels();
    if (session === undefined) throw new Error("nothing lifted");
    expect(session.finish("history.finishPixels")).toBe(true);
    expect(layer.pixels.readRegion(rect(0, 0, 8, 8)).data).toEqual(before);
  });

  it("cancel drops the uncommitted drag and keeps the session", () => {
    const { doc, layer } = selectedDocument();
    const recorded = doc.history.appliedCommands.length;
    const session = doc.liftSelectedPixels();
    if (session === undefined) throw new Error("nothing lifted");
    session.preview(translationAffine(8, 2));
    expect(session.cancel()).toBe(true);
    expect(session.pending).toBe(false);
    expect(session.live).toBe(true);
    expect(pixelOf(layer, 2, 2)).toEqual(RED);
    expect(pixelOf(layer, 8, 2)).toEqual(WHITE);
    expect(doc.history.appliedCommands.length).toBe(recorded);
  });

  it("finish records one item named for the finish and ends the session", async () => {
    const { doc, layer } = selectedDocument();
    const session = doc.liftSelectedPixels();
    if (session === undefined) throw new Error("nothing lifted");
    session.preview(translationAffine(8, 2));
    session.commit("history.movePixels");
    expect(session.finish("history.finishPixels")).toBe(true);
    expect(doc.history.undoName).toBe("history.finishPixels");
    expect(session.live).toBe(false);
    expect(session.preview(translationAffine(0, 0))).toBe(false);
    expect(pixelOf(layer, 8, 2)).toEqual(RED);
  });

  it("ends the session when an undo changes the document behind it", async () => {
    const { doc } = selectedDocument();
    const session = doc.liftSelectedPixels();
    if (session === undefined) throw new Error("nothing lifted");
    session.preview(translationAffine(8, 2));
    session.commit("history.movePixels");
    await doc.history.undo();
    expect(session.live).toBe(false);
    expect(session.commit("history.movePixels")).toBe(false);
  });

  it("ends the session when the selection is replaced", () => {
    const { doc } = selectedDocument();
    const session = doc.liftSelectedPixels();
    if (session === undefined) throw new Error("nothing lifted");
    doc.deselect();
    expect(session.live).toBe(false);
  });

  it("stamps a copy when Ctrl is held, so the source stays behind", () => {
    const { doc, layer } = selectedDocument();
    const session = doc.liftSelectedPixels();
    if (session === undefined) throw new Error("nothing lifted");
    expect(session.stamp()).toBe(true);
    session.preview(translationAffine(8, 2));
    session.commit("history.movePixels");
    expect(pixelOf(layer, 2, 2)).toEqual(RED);
    expect(pixelOf(layer, 8, 2)).toEqual(RED);
  });

  it("undoes a stamp when it is cancelled", () => {
    const { doc, layer } = selectedDocument();
    const session = doc.liftSelectedPixels();
    if (session === undefined) throw new Error("nothing lifted");
    session.stamp();
    session.preview(translationAffine(8, 2));
    session.cancel();
    session.preview(translationAffine(2, 2));
    session.commit("history.movePixels");
    expect(pixelOf(layer, 2, 2)).toEqual(RED);
    expect(pixelOf(layer, 8, 2)).toEqual(WHITE);
  });

  it("grows its area when the content moves off the first region and keeps untouched pixels", async () => {
    const { doc, layer } = selectedDocument();
    const session = doc.liftSelectedPixels();
    if (session === undefined) throw new Error("nothing lifted");
    session.preview(translationAffine(2 + 10, 12));
    session.commit("history.movePixels");
    expect(pixelOf(layer, 12, 12)).toEqual(RED);
    expect(pixelOf(layer, 0, 0)).toEqual(WHITE);
    expect(pixelOf(layer, 15, 15)).toEqual(RED);
    expect(pixelOf(layer, 11, 11)).toEqual(WHITE);
    await doc.history.undo();
    expect(pixelOf(layer, 2, 2)).toEqual(RED);
    expect(pixelOf(layer, 12, 12)).toEqual(WHITE);
  });

  it("clips the content to the canvas and keeps a fraction-free copy when it leaves", () => {
    const { doc, layer } = selectedDocument();
    const session = doc.liftSelectedPixels();
    if (session === undefined) throw new Error("nothing lifted");
    session.preview(translationAffine(14, 14));
    session.commit("history.movePixels");
    expect(pixelOf(layer, 14, 14)).toEqual(RED);
    expect(pixelOf(layer, 15, 15)).toEqual(RED);
    expect(pixelOf(layer, 13, 13)).toEqual(WHITE);
  });

  it("lifts the whole layer when nothing is selected", () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    const session = doc.liftSelectedPixels();
    if (session === undefined) throw new Error("nothing lifted");
    session.preview(translationAffine(1, 0));
    expect(pixelOf(doc.activeLayer as Layer, 0, 0).a).toBe(0);
    expect(pixelOf(doc.activeLayer as Layer, 1, 0)).toEqual(WHITE);
    expect(session.bounds).toEqual(rect(1, 0, 8, 8));
  });

  it("selects the whole canvas when nothing is selected, and records it with the move as one item", async () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    const layer = doc.activeLayer as Layer;
    const before = doc.history.appliedCommands.length;
    const session = doc.liftSelectedPixels();
    if (session === undefined) throw new Error("nothing lifted");
    session.preview(translationAffine(2, 1));
    expect(doc.selection.bounds()).toEqual(rect(2, 1, 8, 8));
    expect(session.commit("Move Pixels")).toBe(true);
    expect(doc.history.appliedCommands.length).toBe(before + 1);
    expect(doc.history.undoName).toBe("Move Pixels");
    expect(doc.selection.bounds()).toEqual(rect(2, 1, 8, 8));
    expect(pixelOf(layer, 0, 0).a).toBe(0);
    expect(pixelOf(layer, 2, 1)).toEqual(WHITE);
    await doc.history.undo();
    expect(doc.selection.isEmpty).toBe(true);
    expect(pixelOf(layer, 0, 0)).toEqual(WHITE);
  });

  it("refuses a lift that does not fit the memory budget, and changes nothing", () => {
    const tile = TiledPixelStore.estimateBytes(256, 256);
    const doc = Document.createBlank({
      width: 16,
      height: 16,
      accountant: new MemoryAccountant(tile),
    });
    doc.selectAll();
    const before = doc.history.appliedCommands.length;
    expect(() => doc.liftSelectedPixels()).toThrow(OutOfMemoryError);
    expect(doc.history.appliedCommands.length).toBe(before);
    expect(doc.activeLayer?.pixels.getPixel(0, 0)).toEqual(WHITE);
  });

  it("refuses a lift with no layer and an empty session when the layer is gone", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.selectAll();
    expect(doc.liftSelectedPixels()).toBeDefined();
    doc.dispose();
    expect(doc.liftSelectedPixels()).toBeUndefined();
  });
});

describe("pasting as floating content (DOC-CLP-05, TL-MOVE-PIX-01)", () => {
  function blueImage(width: number, height: number): ClipboardImage {
    const pixels = new Surface(width, height);
    pixels.fill(BLUE);
    return { pixels };
  }

  it("records the paste and then moves the pasted pixels in the session", async () => {
    const doc = Document.createBlank({ width: 16, height: 16 });
    const layer = doc.activeLayer as Layer;
    const session = doc.pasteFloating(blueImage(2, 2), { x: 1, y: 1 });
    expect(doc.history.undoName).toBe("Paste");
    expect(pixelOf(layer, 1, 1)).toEqual(BLUE);
    expect(doc.selection.bounds()).toEqual(rect(1, 1, 2, 2));

    session.preview(translationAffine(6, 5));
    expect(pixelOf(layer, 1, 1)).toEqual(WHITE);
    expect(pixelOf(layer, 6, 5)).toEqual(BLUE);
    session.commit("history.movePixels");
    expect(pixelOf(layer, 6, 5)).toEqual(BLUE);
    expect(pixelOf(layer, 1, 1)).toEqual(WHITE);

    await doc.history.undo();
    expect(pixelOf(layer, 1, 1)).toEqual(BLUE);
    expect(pixelOf(layer, 6, 5)).toEqual(WHITE);
  });

  it("expands the canvas with the paste as one item", () => {
    const doc = Document.createBlank({ width: 4, height: 4 });
    doc.pasteFloating(blueImage(6, 6), { x: 0, y: 0 }, { expandTo: { width: 6, height: 6 } });
    expect(doc.width).toBe(6);
    expect(doc.history.undoName).toBe("Canvas Size");
  });

  it("pastes into a new layer and keeps the new layer as the session's layer", () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    const session = doc.pasteFloating(blueImage(2, 2), { x: 0, y: 0 }, { newLayer: true });
    expect(doc.layerCount).toBe(2);
    expect(session.layer).toBe(doc.activeLayer);
    expect(pixelOf(session.layer, 0, 0)).toEqual(BLUE);
  });

  it("finishes the paste as Finish Pixels", () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    const session = doc.pasteFloating(blueImage(2, 2), { x: 3, y: 3 });
    expect(session.finish("history.finishPixels")).toBe(true);
    expect(doc.history.undoName).toBe("history.finishPixels");
    expect(doc.selection.bounds()).toEqual(rect(3, 3, 2, 2));
  });

  it("returns a session that goes stale once a second paste is recorded", () => {
    const doc = Document.createBlank({ width: 8, height: 8 });
    const first = doc.pasteFloating(blueImage(1, 1), { x: 0, y: 0 });
    doc.pasteFloating(blueImage(1, 1), { x: 4, y: 4 });
    expect(first.live).toBe(false);
  });
});

describe("placing moved pixels by coverage (TL-MOVE-PIX-01)", () => {
  const HALF_BLUE = rgba8(0, 0, 255, 128);
  const CLEAR = rgba8(0, 0, 0, 0);
  const whole = (layer: Layer) => [...layer.pixels.readRegion(layer.pixels.bounds).data];

  /** A white document with a selected 4 x 4 block at (2, 2): a clear, a half-alpha and red columns. */
  function mixedDocument() {
    const doc = Document.createBlank({ width: 16, height: 16 });
    const layer = doc.activeLayer as Layer;
    const block = new Surface(4, 4);
    block.fill(RED);
    block.fill(rgba8(0, 0, 0, 0), rect(0, 0, 1, 4));
    block.fill(HALF_BLUE, rect(1, 0, 1, 4));
    doc.editLayerPixels("paint", layer, rect(2, 2, 4, 4), (pixels) => {
      pixels.writeRegion(block, 2, 2);
    });
    doc.replaceSelection(new Selection([rectPolygon(rect(2, 2, 4, 4))]), "select");
    const session = doc.liftSelectedPixels();
    if (session === undefined) throw new Error("nothing lifted");
    return { doc, layer, session };
  }

  it("overwrites an opaque destination with a fully transparent part of the content", () => {
    const { layer, session } = mixedDocument();
    session.preview(translationAffine(8, 2));
    expect(pixelOf(layer, 8, 3)).toEqual(CLEAR);
    session.commit("history.movePixels");
    expect(pixelOf(layer, 8, 3)).toEqual(CLEAR);
  });

  it("replaces the destination with a half-alpha pixel instead of blending over it", () => {
    const { layer, session } = mixedDocument();
    session.preview(translationAffine(8, 2));
    expect(pixelOf(layer, 9, 3)).toEqual(HALF_BLUE);
    expect(pixelOf(layer, 10, 3)).toEqual(RED);
    // The vacated area is transparent, and the layer around the content is untouched.
    expect(pixelOf(layer, 4, 3).a).toBe(0);
    expect(pixelOf(layer, 12, 3)).toEqual(WHITE);
  });

  it("replaces the content landing on other moved content as well", () => {
    const { layer, session } = mixedDocument();
    // Moved one pixel right, the clear column lands on the old clear column's right neighbour.
    session.preview(translationAffine(3, 2));
    expect(pixelOf(layer, 3, 3)).toEqual(CLEAR);
    expect(pixelOf(layer, 4, 3)).toEqual(HALF_BLUE);
    expect(pixelOf(layer, 2, 3)).toEqual(CLEAR);
  });

  it("blends an antialiased edge by the selection's coverage", () => {
    const doc = Document.createBlank({ width: 16, height: 8 });
    const layer = doc.activeLayer as Layer;
    const red = new Surface(4, 4);
    red.fill(RED);
    doc.editLayerPixels("paint", layer, rect(2, 2, 4, 4), (pixels) => {
      pixels.writeRegion(red, 2, 2);
    });
    doc.replaceSelection(new Selection([[2, 2, 5.5, 2, 5.5, 6, 2, 6]]), "select");
    const c = doc.selection.mask(rect(5, 2, 1, 1))[0] ?? 0;
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(255);
    const session = doc.liftSelectedPixels();
    if (session === undefined) throw new Error("nothing lifted");
    session.preview(translationAffine(10, 2));
    const lerp = (o: number, e: number) => Math.floor((o * (255 - c) + e * c + 127) / 255);
    expect(pixelOf(layer, 13, 3)).toEqual(rgba8(255, lerp(255, 0), lerp(255, 0), 255));
    expect(pixelOf(layer, 12, 3)).toEqual(RED);
    expect(pixelOf(layer, 14, 3)).toEqual(WHITE);
  });

  it("commits what the preview showed, for a move and a rotation, and undo restores", async () => {
    const { doc, layer, session } = mixedDocument();
    const original = whole(layer);
    session.preview(translationAffine(8, 2));
    const moved = whole(layer);
    session.commit("history.movePixels");
    expect(whole(layer)).toEqual(moved);

    const turn = { a: 0.8, b: 0.6, c: -0.6, d: 0.8, e: 9.5, f: 3.25 };
    session.preview(turn);
    const turned = whole(layer);
    // Inside the rotated selection a clear pixel replaced the white destination.
    expect(turned).not.toEqual(moved);
    session.commit("history.rotatePixels");
    expect(whole(layer)).toEqual(turned);

    await doc.history.undo();
    expect(whole(layer)).toEqual(moved);
    await doc.history.undo();
    expect(whole(layer)).toEqual(original);
    await doc.history.redo();
    await doc.history.redo();
    expect(whole(layer)).toEqual(turned);
  });

  it("covers a rotation with the rotated selection, replacing transparent content inside it", () => {
    const doc = Document.createBlank({ width: 16, height: 16 });
    const layer = doc.activeLayer as Layer;
    // A clear layer region, selected and turned by 90 degrees over the white rest.
    doc.editLayerPixels("clear", layer, rect(0, 0, 4, 4), (pixels) => {
      pixels.writeRegion(new Surface(4, 4), 0, 0);
    });
    doc.replaceSelection(new Selection([rectPolygon(rect(0, 0, 4, 4))]), "select");
    const session = doc.liftSelectedPixels();
    if (session === undefined) throw new Error("nothing lifted");
    session.preview({ a: 0, b: 1, c: -1, d: 0, e: 12, f: 8 });
    expect(pixelOf(layer, 9, 9)).toEqual(CLEAR);
    expect(pixelOf(layer, 12, 9)).toEqual(WHITE);
    expect(pixelOf(layer, 9, 12)).toEqual(WHITE);
  });

  it("places pasted content with transparency over the layer, and moves it the same way", () => {
    const doc = Document.createBlank({ width: 16, height: 16 });
    const layer = doc.activeLayer as Layer;
    const pixels = new Surface(2, 1);
    pixels.setPixel(0, 0, HALF_BLUE);
    const session = doc.pasteFloating({ pixels }, { x: 1, y: 1 });
    expect(pixelOf(layer, 1, 1)).toEqual(HALF_BLUE);
    expect(pixelOf(layer, 2, 1)).toEqual(CLEAR);
    session.preview(translationAffine(6, 5));
    expect(pixelOf(layer, 6, 5)).toEqual(HALF_BLUE);
    expect(pixelOf(layer, 7, 5)).toEqual(CLEAR);
    expect(pixelOf(layer, 1, 1)).toEqual(WHITE);
  });
});

describe("placeByCoverage", () => {
  it("is clipToCoverage's lerp of destination and source, with uncovered pixels kept", () => {
    const dst = new Surface(12, 9);
    const src = new Surface(7, 6);
    const coverage = new Uint8Array(7 * 6);
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed >>> 16;
    };
    for (const surface of [dst, src]) {
      for (let i = 0; i < surface.data.length; i++) surface.data[i] = next() % 256;
    }
    const weights = [0, 255, 1, 128, 254];
    for (let i = 0; i < coverage.length; i++) coverage[i] = weights[next() % weights.length] ?? 0;
    // The source hangs over the destination's right edge, so it is clipped too.
    const expected = dst.clone();
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 4; x++) {
        const c = coverage[y * 7 + x] ?? 0;
        for (let k = 0; k < 4; k++) {
          const o = ((2 + y) * 12 + 8 + x) * 4 + k;
          const e = src.data[(y * 7 + x) * 4 + k] ?? 0;
          expected.data[o] = Math.floor(((dst.data[o] ?? 0) * (255 - c) + e * c + 127) / 255);
        }
      }
    }
    placeByCoverage(dst, src, 8, 2, coverage);
    expect([...dst.data]).toEqual([...expected.data]);
  });

  it("copies the whole source, transparent pixels included, without coverage", () => {
    const dst = new Surface(3, 1);
    dst.fill(WHITE);
    const src = new Surface(2, 1);
    placeByCoverage(dst, src, 1, 0);
    expect(dst.getPixel(0, 0)).toEqual(WHITE);
    expect(dst.getPixel(1, 0).a).toBe(0);
    expect(dst.getPixel(2, 0).a).toBe(0);
  });
});

describe("remainingAfterLift", () => {
  it("clears only the alpha of a whole lift, the same as full coverage does", () => {
    const pixels = new Surface(
      3,
      2,
      Uint8ClampedArray.from({ length: 24 }, (_, i) => i * 10),
    );
    const whole = remainingAfterLift(pixels, undefined);
    expect(whole).toEqual(remainingAfterLift(pixels, new Uint8Array(6).fill(255)));
    expect(whole.getPixel(1, 0)).toEqual({ r: 40, g: 50, b: 60, a: 0 });
    expect(pixels.getPixel(1, 0).a).toBe(70);
  });
});

describe("Move Selected Pixels previews resampled elsewhere (L7)", () => {
  const turn = (session: { readonly transform: { e: number; f: number } }) => ({
    a: Math.cos(0.4),
    b: Math.sin(0.4),
    c: -Math.sin(0.4),
    d: Math.cos(0.4),
    e: session.transform.e + 1.3,
    f: session.transform.f,
  });

  /** A resampler that answers each call with a solid green surface when `release` is called. */
  function pendingResampler() {
    const calls: { width: number; height: number; release: () => void; fail: () => void }[] = [];
    const resampler: TransformResampler = (_source, spec) =>
      new Promise((resolve, reject) => {
        const out = new Surface(spec.width, spec.height);
        out.fill(GREEN);
        calls.push({
          width: spec.width,
          height: spec.height,
          release: () => resolve(out),
          fail: () => reject(new Error("device lost")),
        });
      });
    return { calls, resampler };
  }

  const GREEN = rgba8(0, 255, 0);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("shows the resampled preview, runs only the newest transform next, and commits the reference", async () => {
    const { doc, layer } = selectedDocument();
    const reference = selectedDocument();
    const session = doc.liftSelectedPixels();
    const plain = reference.doc.liftSelectedPixels();
    if (session === undefined || plain === undefined) throw new Error("nothing lifted");
    const { calls, resampler } = pendingResampler();
    session.setResampler(resampler);
    const m = turn(session);
    session.preview(m);
    session.preview({ ...m, e: m.e + 0.5 });
    session.preview({ ...m, e: m.e + 1 });
    expect(calls).toHaveLength(1);
    calls[0]?.release();
    await settle();
    // The first result is shown, and the newest transform is resampled next.
    expect(pixelOf(layer, 4, 4)).toEqual(GREEN);
    expect(calls).toHaveLength(2);
    calls[1]?.release();
    await settle();
    expect(calls).toHaveLength(2);
    expect(session.commit("Rotate Pixels")).toBe(true);
    plain.preview({ ...m, e: m.e + 1 });
    plain.commit("Rotate Pixels");
    const all = (target: Layer) => [...target.pixels.readRegion(target.pixels.bounds).data];
    expect(all(layer)).toEqual(all(reference.layer));
  });

  it("previews with the reference once the resampler fails", async () => {
    const { doc, layer } = selectedDocument();
    const reference = selectedDocument();
    const session = doc.liftSelectedPixels();
    const plain = reference.doc.liftSelectedPixels();
    if (session === undefined || plain === undefined) throw new Error("nothing lifted");
    const { calls, resampler } = pendingResampler();
    session.setResampler(resampler);
    const m = turn(session);
    session.preview(m);
    calls[0]?.fail();
    await settle();
    plain.preview(m);
    const all = (target: Layer) => [...target.pixels.readRegion(target.pixels.bounds).data];
    expect(all(layer)).toEqual(all(reference.layer));
    session.preview({ ...m, e: m.e + 1 });
    expect(calls).toHaveLength(1);
  });

  it("drops a resampled preview that lands after a cancel", async () => {
    const { doc, layer } = selectedDocument();
    const session = doc.liftSelectedPixels();
    if (session === undefined) throw new Error("nothing lifted");
    const before = [...layer.pixels.readRegion(layer.pixels.bounds).data];
    const { calls, resampler } = pendingResampler();
    session.setResampler(resampler);
    session.preview(turn(session));
    session.cancel();
    calls[0]?.release();
    await settle();
    expect([...layer.pixels.readRegion(layer.pixels.bounds).data]).toEqual(before);
  });
});
