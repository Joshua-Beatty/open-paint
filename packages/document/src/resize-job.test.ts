/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { rgba8, WHITE } from "./color";
import { Document } from "./document";
import { HELD_MESSAGE } from "./history/history";
import { type JobControl, OperationCanceledError } from "./job";
import { MemoryAccountant, OutOfMemoryError } from "./memory";
import { resampleSurface } from "./resample";
import { TILE_BYTES } from "./tiled-store";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const NEAREST = { filter: "nearest", linearLight: false } as const;
const RED = rgba8(255, 0, 0);

/** Two layers over a 4 x 4 canvas, with one red pixel on the background, and one undo item. */
function twoLayerDocument(): Document {
  const doc = Document.createBlank({ width: 4, height: 4 });
  doc.layers[0]?.pixels.setPixel(0, 0, RED);
  doc.addLayer();
  return doc;
}

describe("Resize as a background job (DOC-IMG-02)", () => {
  it("gives the same pixels and history item as the synchronous resize", async () => {
    const sync = twoLayerDocument();
    const job = twoLayerDocument();
    sync.resize({ width: 8, height: 6 }, NEAREST);
    expect(await job.resizeWithProgress({ width: 8, height: 6 }, NEAREST)).toBe(true);

    expect(job.width).toBe(8);
    expect(job.height).toBe(6);
    expect(job.history.undoName).toBe("Resize");
    expect(job.dirty).toBe(true);
    expect(job.layers[0]?.pixels.getPixel(0, 0)).toEqual(RED);
    expect(job.layers[1]?.pixels.getPixel(7, 5)).toEqual(sync.layers[1]?.pixels.getPixel(7, 5));
    expect(job.layers[0]?.pixels.getPixel(7, 5)).toEqual(WHITE);
    sync.dispose();
    job.dispose();
  });

  it("resamples each layer through the control's runner, and gives the same pixels", async () => {
    const sync = twoLayerDocument();
    const job = twoLayerDocument();
    sync.resize({ width: 8, height: 6 }, NEAREST);
    const resample = vi.fn(async (...args: Parameters<typeof resampleSurface>) =>
      resampleSurface(...args),
    );
    await job.resizeWithProgress({ width: 8, height: 6 }, NEAREST, undefined, { resample });
    expect(resample).toHaveBeenCalledTimes(2);
    expect(job.layers[1]?.pixels.getPixel(7, 5)).toEqual(sync.layers[1]?.pixels.getPixel(7, 5));
    expect(job.layers[0]?.pixels.getPixel(0, 0)).toEqual(RED);
    sync.dispose();
    job.dispose();
  });

  it("reports the fraction done after each layer, ending at 1", async () => {
    const doc = twoLayerDocument();
    const onProgress = vi.fn<(fraction: number) => void>();
    await doc.resizeWithProgress({ width: 8, height: 8 }, NEAREST, undefined, { onProgress });
    expect(onProgress.mock.calls.map(([fraction]) => fraction)).toEqual([0.5, 1]);
    doc.dispose();
  });

  it("waits for the caller's pause before each slice", async () => {
    const doc = twoLayerDocument();
    const pause = vi.fn(async () => {});
    await doc.resizeWithProgress({ width: 8, height: 8 }, NEAREST, undefined, { pause });
    expect(pause).toHaveBeenCalledTimes(2);
    doc.dispose();
  });

  it("leaves the document unchanged when canceled before the first slice", async () => {
    const doc = twoLayerDocument();
    const entries = doc.history.entries.length;
    const control: JobControl = { isCanceled: () => true };
    await expect(
      doc.resizeWithProgress({ width: 8, height: 8 }, NEAREST, undefined, control),
    ).rejects.toBeInstanceOf(OperationCanceledError);
    expect(doc.width).toBe(4);
    expect(doc.height).toBe(4);
    expect(doc.layers.every((layer) => layer.pixels.width === 4)).toBe(true);
    expect(doc.history.entries.length).toBe(entries);
    doc.dispose();
  });

  it("discards the built layers when canceled between slices", async () => {
    const doc = twoLayerDocument();
    const entries = doc.history.entries.length;
    let canceled = false;
    const control: JobControl = {
      isCanceled: () => canceled,
      onProgress: (fraction) => {
        if (fraction === 0.5) canceled = true;
      },
    };
    await expect(
      doc.resizeWithProgress({ width: 8, height: 8 }, NEAREST, undefined, control),
    ).rejects.toBeInstanceOf(OperationCanceledError);
    expect(doc.width).toBe(4);
    expect(doc.layers.every((layer) => layer.pixels.width === 4)).toBe(true);
    expect(doc.history.entries.length).toBe(entries);
    doc.dispose();
  });

  it("holds the document while the job runs, so edits and undo are refused", async () => {
    const doc = twoLayerDocument();
    expect(doc.history.canUndo).toBe(true);
    const refused: string[] = [];
    const pause = async () => {
      try {
        doc.addLayer();
      } catch (error) {
        if (error instanceof Error) refused.push(error.message);
      }
      expect(doc.history.canUndo).toBe(false);
    };
    await doc.resizeWithProgress({ width: 8, height: 8 }, NEAREST, undefined, { pause });
    expect(refused).toEqual([HELD_MESSAGE, HELD_MESSAGE]);
    expect(doc.layerCount).toBe(2);
    expect(doc.history.canUndo).toBe(true);
    doc.addLayer();
    expect(doc.layerCount).toBe(3);
    doc.dispose();
  });

  it("only changes the resolution when the pixel size is unchanged, without a slice", async () => {
    const doc = twoLayerDocument();
    const pause = vi.fn(async () => {});
    const changed = await doc.resizeWithProgress(
      { width: 4, height: 4 },
      NEAREST,
      { unit: "inch", x: 300, y: 300 },
      { pause },
    );
    expect(changed).toBe(true);
    expect(pause).not.toHaveBeenCalled();
    expect(doc.history.undoName).toBe("Resize");
    expect(doc.resolution).toEqual({ unit: "inch", x: 300, y: 300 });
    doc.dispose();
  });

  it("rolls back on out-of-memory, then accepts the next job", async () => {
    const doc = Document.createBlank({
      width: 4,
      height: 4,
      accountant: new MemoryAccountant(TILE_BYTES * 2),
    });
    await expect(
      doc.resizeWithProgress({ width: 300, height: 300 }, NEAREST),
    ).rejects.toBeInstanceOf(OutOfMemoryError);
    expect(doc.width).toBe(4);
    expect(doc.history.undoName).toBe(undefined);
    expect(await doc.resizeWithProgress({ width: 2, height: 2 }, NEAREST)).toBe(true);
    expect(doc.width).toBe(2);
    doc.dispose();
  });
});
