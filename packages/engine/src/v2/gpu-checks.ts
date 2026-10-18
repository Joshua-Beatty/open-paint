import { rect, Surface, TILE_SIZE, TiledPixelStore } from "@openpaint/document";
import { clipToCoverage } from "@openpaint/effects";
import { type BrushOptions, brushSettingsOf, strokeBrush } from "../brush";
import type { CompositeDocument } from "../composite";
import { compositeCpu } from "../composite-cpu";
import { DocumentMirror, type DocumentSync } from "../document-sync";
import { GpuBrush } from "../gpu-brush";
import { BufferUsage } from "../gpu-device";
import { compositeKey } from "./composite-plan";
import { GpuCompositorV2 } from "./compositor";
import { GpuDocument } from "./gpu-document";
import { SlotBuffer } from "./slot-buffer";
import { GpuStroke, type StrokeMask, StrokePipelines } from "./stroke";
import { TILE_ROW_BYTES } from "./tile-pool";

/**
 * Golden checks of engine v2 against the Rust reference (WEB-GPU-03, ±1 per channel). They run
 * the real v2 classes on a device and compare with the CPU compositor and the CPU brush. The
 * engine's unit tests run them where Node has WebGPU, and the golden harness runs them in
 * Chromium.
 */

export interface CheckResult {
  readonly maxDifference: number;
  readonly differingChannels: number;
}

/** `GPUMapMode.READ`. */
const MAP_READ_MODE = 1;
const NO_CHANGES = { tileChanged: () => undefined, stackChanged: () => undefined };

/** Deterministic noise, so every run exercises the same pixels. */
export function noiseSurface(seed: number, width: number, height: number): Surface {
  let state = seed >>> 0;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    data[i] = state >>> 24;
  }
  return new Surface(width, height, data);
}

/**
 * Opaque noise for the stroke checks: the twins agree on coverage within one level, and over an
 * opaque pixel one level moves each channel by at most one. Over a nearly transparent pixel the
 * straight-alpha colour of a blend magnifies it, which says nothing about the coverage. The
 * empty-layer cases check the coverage on its own, as alpha.
 */
function opaqueNoise(seed: number, width: number, height: number): Surface {
  const surface = noiseSurface(seed, width, height);
  for (let i = 3; i < surface.data.length; i += 4) surface.data[i] = 255;
  return surface;
}

function compare(actual: ArrayLike<number>, expected: ArrayLike<number>): CheckResult {
  let maxDifference = 0;
  let differingChannels = 0;
  for (let i = 0; i < expected.length; i++) {
    const difference = Math.abs((actual[i] ?? 0) - (expected[i] ?? 0));
    if (difference > 0) differingChannels += 1;
    maxDifference = Math.max(maxDifference, difference);
  }
  return { maxDifference, differingChannels };
}

/** A full sync of CPU stores, as the main thread's mirror sends it. */
function fullSync(
  width: number,
  height: number,
  layers: CompositeDocument["layers"],
): DocumentSync {
  return {
    width,
    height,
    full: true,
    layers: layers.map((layer, index) => ({
      id: index + 1,
      visible: layer.visible,
      opacity: layer.opacity,
      mode: layer.mode,
    })),
    tiles: layers.map((layer, index) => ({
      id: index + 1,
      tiles: layer.store.allocatedTiles().map(({ tx, ty }) => {
        const tile = layer.store.getTile(tx, ty);
        return { tx, ty, pixels: tile && new Uint8Array(tile.data.slice().buffer) };
      }),
    })),
  };
}

/** Reads slices of a texture array (level 0) back as whole tiles. */
async function readSlices(
  device: GPUDevice,
  texture: GPUTexture,
  slices: readonly number[],
): Promise<Uint8Array[]> {
  const bytes = TILE_ROW_BYTES * TILE_SIZE;
  const buffer = device.createBuffer({
    size: Math.max(4, slices.length * bytes),
    usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
  });
  const encoder = device.createCommandEncoder();
  slices.forEach((slice, i) => {
    encoder.copyTextureToBuffer(
      { texture, origin: [0, 0, slice] },
      { buffer, offset: i * bytes, bytesPerRow: TILE_ROW_BYTES, rowsPerImage: TILE_SIZE },
      [TILE_SIZE, TILE_SIZE, 1],
    );
  });
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(MAP_READ_MODE);
  const all = new Uint8Array(buffer.getMappedRange());
  const tiles = slices.map((_, i) => all.slice(i * bytes, (i + 1) * bytes));
  buffer.destroy();
  return tiles;
}

/** Writes a whole tile into an image, clipped to it. */
function placeTile(image: Surface, tx: number, ty: number, pixels: Uint8Array): void {
  const tile = new Surface(
    TILE_SIZE,
    TILE_SIZE,
    new Uint8ClampedArray(pixels.buffer as ArrayBuffer),
  );
  image.copyFrom(tile, tile.bounds, tx * TILE_SIZE, ty * TILE_SIZE);
}

export interface CompositeCheckLayer {
  readonly mode: number;
  readonly opacity: number;
  readonly visible?: boolean;
  /** Only this part of the layer is painted; the rest of its tiles stay unallocated. */
  readonly area?: { x: number; y: number; width: number; height: number };
}

/**
 * Composites noise layers with the v2 compositor at mip level 0 and compares the result with
 * `compositeCpu`. `pageSlices` makes tile pages tiny, so the stack spans many pages and the
 * compositor must split it into chunks.
 */
export async function checkCompositeV2(
  device: GPUDevice,
  width: number,
  height: number,
  layers: readonly CompositeCheckLayer[],
  pageSlices?: number,
): Promise<CheckResult> {
  const stack = layers.map((layer, index) => {
    const store = new TiledPixelStore(width, height);
    const area = layer.area ?? { x: 0, y: 0, width, height };
    store.writeRegion(noiseSurface(index + 1, area.width, area.height), area.x, area.y);
    return { store, mode: layer.mode, opacity: layer.opacity, visible: layer.visible ?? true };
  });
  const doc = new GpuDocument(device, NO_CHANGES, pageSlices);
  const compositor = new GpuCompositorV2(device, doc.pool, { premultiply: false });
  try {
    doc.apply(fullSync(width, height, stack));
    const across = Math.ceil(width / TILE_SIZE);
    const down = Math.ceil(height / TILE_SIZE);
    const draws = [];
    for (let cy = 0; cy < down; cy++) {
      for (let cx = 0; cx < across; cx++) {
        draws.push({
          key: compositeKey(0, cx, cy),
          level: 0,
          cx,
          cy,
          dst: rect(cx * TILE_SIZE, cy * TILE_SIZE, TILE_SIZE, TILE_SIZE),
          cover: { x: 1, y: 1 },
        });
      }
    }
    const encoder = device.createCommandEncoder();
    doc.pool.flushMips(encoder);
    const slots = compositor.encode(encoder, draws, doc.table.build(), doc.table.tilesX, {
      width,
      height,
    });
    device.queue.submit([encoder.finish()]);
    doc.pool.afterSubmit();
    const texture = compositor.texture;
    if (!texture) throw new Error("The compositor blended nothing.");
    const tiles = await readSlices(device, texture, slots);
    const actual = new Surface(width, height);
    draws.forEach((draw, i) => {
      placeTile(actual, draw.cx, draw.cy, tiles[i] as Uint8Array);
    });
    const expected = compositeCpu({ width, height, layers: stack }, rect(0, 0, width, height));
    return compare(actual.data, expected.data);
  } finally {
    compositor.destroy();
    doc.destroy();
    for (const layer of stack) layer.store.dispose();
  }
}

/**
 * Syncs a noise layer to a `GpuDocument` through `DocumentMirror`, then edits small parts of
 * existing tiles and of a tile allocated since, so the deltas send partial tiles (L9). Reads every
 * tile back and compares it with the CPU store. The result must be exact.
 */
export async function checkPartialSyncV2(device: GPUDevice): Promise<CheckResult> {
  const width = 600;
  const height = 300;
  const store = new TiledPixelStore(width, height);
  store.writeRegion(noiseSurface(7, 300, 300), 0, 0);
  const mirror = new DocumentMirror();
  const layers = [{ id: 1, visible: true, opacity: 255, blendMode: 0, pixels: store }];
  const doc = new GpuDocument(device, NO_CHANGES);
  try {
    doc.apply(mirror.describe({ width, height, layers }));
    store.writeRegion(noiseSurface(8, 7, 5), 20, 30);
    store.writeRegion(noiseSurface(9, 30, 20), 240, 250);
    store.writeRegion(noiseSurface(10, 9, 9), 520, 100);
    const delta = mirror.describe({ width, height, layers });
    if (!delta.tiles[0]?.tiles.some((tile) => tile.rect !== undefined)) {
      throw new Error("The delta sent no partial tile.");
    }
    doc.apply(delta);
    const coords = store.allocatedTiles();
    const bytes = TILE_ROW_BYTES * TILE_SIZE;
    const buffer = device.createBuffer({
      size: coords.length * bytes,
      usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
    });
    const encoder = device.createCommandEncoder();
    coords.forEach(({ tx, ty }, i) => {
      const code = doc.table.tile(1, tx, ty);
      if (code === undefined) throw new Error(`Tile ${tx},${ty} was not uploaded.`);
      doc.pool.copyToBuffer(encoder, code, buffer, i * bytes);
    });
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(MAP_READ_MODE);
    const all = new Uint8Array(buffer.getMappedRange()).slice();
    buffer.destroy();
    const actual = new Surface(width, height);
    coords.forEach(({ tx, ty }, i) => {
      placeTile(actual, tx, ty, all.slice(i * bytes, (i + 1) * bytes));
    });
    return compare(actual.data, store.readRegion(store.bounds).data);
  } finally {
    doc.destroy();
    store.dispose();
  }
}

export interface StrokeCheck {
  readonly width: number;
  readonly height: number;
  readonly options: BrushOptions;
  /** Flat `x, y, pressure` samples in image pixels. */
  readonly path: readonly number[];
  /** Samples per batch, as the main thread sends them once per frame. */
  readonly batch: number;
  /** Batches pushed before each frame is encoded (1 when omitted), as when frames fall behind. */
  readonly perFrame?: number;
  /** Coverage over the whole image, one byte per pixel, or undefined for no selection. */
  readonly mask?: Uint8Array;
  /** Leaves the layer transparent instead of filling it with noise. */
  readonly empty?: boolean;
}

/**
 * Paints a stroke with `GpuStroke` in batches, commits it, and compares the read-back layer with
 * `strokeBrush` (the Rust reference) on the whole image, clipped to the mask like
 * `clipToCoverage`.
 */
export async function checkStrokeV2(device: GPUDevice, check: StrokeCheck): Promise<CheckResult> {
  const { width, height, options } = check;
  const original = check.empty ? new Surface(width, height) : opaqueNoise(7, width, height);
  const store = new TiledPixelStore(width, height);
  if (!check.empty) store.writeRegion(original, 0, 0);
  const doc = new GpuDocument(device, NO_CHANGES);
  const pipelines = new StrokePipelines(device);
  const slots = new SlotBuffer(device, 2);
  try {
    doc.apply(fullSync(width, height, [{ store, mode: 0, opacity: 255, visible: true }]));
    const mask: StrokeMask | undefined = check.mask && {
      x: 0,
      y: 0,
      width,
      height,
      data: check.mask,
    };
    const stroke = new GpuStroke(device, doc, pipelines, slots, {
      layerId: 1,
      options,
      ...(mask && { mask }),
    });
    const frame = (record: (encoder: GPUCommandEncoder) => void) => {
      const encoder = device.createCommandEncoder();
      record(encoder);
      doc.pool.flushMips(encoder);
      device.queue.submit([encoder.finish()]);
      doc.pool.afterSubmit();
    };
    const step = check.batch * 3;
    const perFrame = check.perFrame ?? 1;
    for (let i = 0, batches = 0; i < check.path.length; i += step) {
      stroke.push(new Float32Array(check.path.slice(i, i + step)));
      batches += 1;
      if (batches % perFrame === 0) frame((encoder) => stroke.encode(encoder));
    }
    stroke.finish();
    let read: ReturnType<GpuStroke["commit"]> | undefined;
    frame((encoder) => {
      stroke.encode(encoder);
      read = stroke.commit(encoder);
    });
    const tiles = await (read as NonNullable<typeof read>)();
    const actual = new Surface(width, height, new Uint8ClampedArray(original.data));
    for (const tile of tiles) placeTile(actual, tile.tx, tile.ty, tile.pixels);

    const painted = strokeBrush(original, new Float32Array(check.path), options);
    const expected = check.mask ? clipToCoverage(original, painted, check.mask) : painted;
    return compare(actual.data, expected.data);
  } finally {
    slots.destroy();
    doc.destroy();
    store.dispose();
  }
}

/**
 * Renders a whole stroke with the engine v1 `GpuBrush` over noise and compares it with
 * `strokeBrush`, the Rust reference.
 */
export async function checkBrushV1(device: GPUDevice, check: StrokeCheck): Promise<CheckResult> {
  const { width, height, options } = check;
  const original = check.empty ? new Surface(width, height) : opaqueNoise(11, width, height);
  const path = new Float32Array(check.path);
  const settings = brushSettingsOf(options);
  try {
    const actual = await new GpuBrush(device).run(original, path, settings);
    return compare(actual.data, strokeBrush(original, path, options).data);
  } finally {
    settings.free();
  }
}
