/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { rect, Surface, TILE_SIZE, TiledPixelStore } from "@openpaint/document";
import { beforeAll, describe, expect, it } from "vitest";
import { type CompositeDocument, LAYER_BLEND_MODE_COUNT } from "./composite";
import { compositeCpu } from "./composite-cpu";
import { initCpu } from "./cpu";
import { type ComposedTile, GpuCompositor } from "./gpu-compositor";
import { TextureUsage } from "./gpu-device";
import { GpuTileCache } from "./gpu-tiles";

/** Skips every test in this file when the runtime has no WebGPU adapter (e.g. plain Node). */
async function requestTestDevice(): Promise<GPUDevice | undefined> {
  const gpu = globalThis.navigator?.gpu;
  if (!gpu) return undefined;
  try {
    const adapter = await gpu.requestAdapter();
    return await adapter?.requestDevice();
  } catch {
    return undefined;
  }
}

const device = await requestTestDevice();
const WIDTH = 300;
const HEIGHT = 200;
/** Bytes per row of a tile-sized RGBA8 readback; WebGPU needs a multiple of 256. */
const ROW_BYTES = TILE_SIZE * 4;

/** Deterministic noise, so every run exercises the same pixels. */
function noise(seed: number, width: number, height: number): Surface {
  let state = seed >>> 0;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    data[i] = state >>> 24;
  }
  return new Surface(width, height, data);
}

function layerStore(seed: number): TiledPixelStore {
  const store = new TiledPixelStore(WIDTH, HEIGHT);
  store.writeRegion(noise(seed, WIDTH, HEIGHT), 0, 0);
  return store;
}

/** Copies a GPU texture's tile-sized contents back to the CPU. */
async function readTexture(gpu: GPUDevice, texture: GPUTexture): Promise<Uint8Array> {
  const buffer = gpu.createBuffer({
    size: ROW_BYTES * TILE_SIZE,
    usage: 0x1 | 0x8, // MAP_READ | COPY_DST
  });
  const encoder = gpu.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: ROW_BYTES }, [
    TILE_SIZE,
    TILE_SIZE,
  ]);
  gpu.queue.submit([encoder.finish()]);
  await buffer.mapAsync(1); // GPUMapMode.READ
  const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  return bytes;
}

/** Assembles the composed tiles into one `WIDTH` x `HEIGHT` straight-alpha image. */
async function readComposite(
  gpu: GPUDevice,
  composed: readonly ComposedTile[],
): Promise<Uint8Array> {
  const out = new Uint8Array(WIDTH * HEIGHT * 4);
  for (const tile of composed) {
    const bytes = await readTexture(gpu, tile.texture);
    for (let y = 0; y < TILE_SIZE; y++) {
      const dy = tile.y + y;
      if (dy >= HEIGHT) break;
      for (let x = 0; x < TILE_SIZE; x++) {
        const dx = tile.x + x;
        if (dx >= WIDTH) break;
        const from = y * ROW_BYTES + x * 4;
        out.set(bytes.subarray(from, from + 4), (dy * WIDTH + dx) * 4);
      }
    }
  }
  return out;
}

function maxDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return max;
}

describe.runIf(device !== undefined)("GpuCompositor (WebGPU)", () => {
  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
  });

  it("composites every layer blend mode and opacity within ±1 of the Rust reference", async () => {
    const gpu = device as GPUDevice;
    const tiles = new GpuTileCache();
    tiles.setDevice(gpu);
    const base = layerStore(1);
    const top = layerStore(2);
    tiles.track(base);
    tiles.track(top);
    const compositor = new GpuCompositor(gpu, tiles, "rgba8unorm");
    const region = rect(0, 0, WIDTH, HEIGHT);

    for (let mode = 0; mode < LAYER_BLEND_MODE_COUNT; mode++) {
      for (const opacity of [255, 128, 1]) {
        const doc: CompositeDocument = {
          width: WIDTH,
          height: HEIGHT,
          layers: [
            { store: base, mode: 0, opacity: 255, visible: true },
            { store: top, mode, opacity, visible: true },
          ],
        };
        const expected = compositeCpu(doc, region).data;
        const actual = await readComposite(gpu, compositor.compose(doc, region));
        expect(
          maxDifference(actual, expected),
          `mode ${mode} opacity ${opacity}`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it("presents composited tiles as premultiplied pixels and clears the rest", async () => {
    const gpu = device as GPUDevice;
    const tiles = new GpuTileCache();
    tiles.setDevice(gpu);
    const store = layerStore(3);
    tiles.track(store);
    const compositor = new GpuCompositor(gpu, tiles, "rgba8unorm");
    const doc: CompositeDocument = {
      width: WIDTH,
      height: HEIGHT,
      layers: [{ store, mode: 0, opacity: 255, visible: true }],
    };
    const canvasWidth = 512;
    const canvasHeight = 256;
    const target = gpu.createTexture({
      size: [canvasWidth, canvasHeight],
      format: "rgba8unorm",
      usage: 0x10 | TextureUsage.COPY_SRC, // RENDER_ATTACHMENT | COPY_SRC
    });
    const composed = compositor.compose(doc, rect(0, 0, WIDTH, HEIGHT));
    compositor.draw(target.createView(), canvasWidth, canvasHeight, composed);

    const buffer = gpu.createBuffer({ size: canvasWidth * 4 * canvasHeight, usage: 0x1 | 0x8 });
    const encoder = gpu.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: canvasWidth * 4 }, [
      canvasWidth,
      canvasHeight,
    ]);
    gpu.queue.submit([encoder.finish()]);
    await buffer.mapAsync(1);
    const pixels = new Uint8Array(buffer.getMappedRange().slice(0));
    buffer.destroy();
    target.destroy();

    const cpu = compositeCpu(doc, rect(0, 0, WIDTH, HEIGHT));
    const expected = new Uint8Array(canvasWidth * canvasHeight * 4);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const { r, g, b, a } = cpu.getPixel(x, y);
        const i = (y * canvasWidth + x) * 4;
        expected.set(
          [Math.round((r * a) / 255), Math.round((g * a) / 255), Math.round((b * a) / 255), a],
          i,
        );
      }
    }
    expect(maxDifference(pixels, expected)).toBeLessThanOrEqual(1);
  });
});
