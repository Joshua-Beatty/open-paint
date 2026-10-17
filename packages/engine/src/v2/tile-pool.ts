import { type Rect, TILE_SIZE } from "@openpaint/document";
import { BufferUsage, TextureUsage } from "../gpu-device";
import { MAX_MIP_LEVEL } from "./composite-plan";
import { slotPage, slotSlice, TileAllocator } from "./tile-allocator";
import { MIP_WGSL } from "./wgsl";

/** Mip levels of a layer tile: 256 px down to 1 px. */
export const TILE_MIPS = MAX_MIP_LEVEL + 1;
/** Bytes of one tile at mip level 0. */
export const TILE_BYTES = TILE_SIZE * TILE_SIZE * 4;
/** Bytes per row of a tile, which WebGPU copies need as a multiple of 256. */
export const TILE_ROW_BYTES = TILE_SIZE * 4;
/** The largest page; a page doubles from 16 slices up to this (or the device's limit). */
const MAX_PAGE_SLICES = 1024;
const PAGE_USAGE =
  TextureUsage.TEXTURE_BINDING |
  TextureUsage.STORAGE_BINDING |
  TextureUsage.COPY_DST |
  TextureUsage.COPY_SRC;

interface Page {
  texture: GPUTexture;
  capacity: number;
  /** Bumped whenever the texture is replaced, so cached views and bind groups are renewed. */
  generation: number;
  sampled: GPUTextureView;
  /** Per mip level, a view of that level alone across all slices. */
  levels: GPUTextureView[];
}

/**
 * The GPU storage of layer tiles: 256 px `rgba8unorm` slices, straight
 * alpha like the CPU store, in a few texture arrays with full mip chains. Writes mark a slice's
 * mips stale, and `flushMips` rebuilds the stale ones on the GPU, one dispatch per page and level.
 */
export class GpuTilePool {
  readonly allocator: TileAllocator;
  readonly #device: GPUDevice;
  readonly #pages: Page[] = [];
  readonly #stale = new Set<number>();
  readonly #garbage: GPUBuffer[] = [];
  readonly #mipPipeline: GPUComputePipeline;
  #generation = 0;

  /** `pageSlices` caps the page size below the default, so tests can exercise many pages. */
  constructor(device: GPUDevice, pageSlices = MAX_PAGE_SLICES) {
    this.#device = device;
    const limit = device.limits.maxTextureArrayLayers;
    this.allocator = new TileAllocator(
      Math.min(pageSlices, MAX_PAGE_SLICES, limit),
      Math.min(16, pageSlices),
    );
    const module = device.createShaderModule({ label: "v2 tile mips", code: MIP_WGSL });
    this.#mipPipeline = device.createComputePipeline({
      label: "v2 tile mips",
      layout: "auto",
      compute: { module, entryPoint: "mip" },
    });
  }

  get pageCount(): number {
    return this.#pages.length;
  }

  /** GPU bytes held by the pages, mips included. */
  get bytes(): number {
    return this.#pages.reduce((sum, page) => sum + page.capacity * TILE_BYTES * (4 / 3), 0);
  }

  /** Changes whenever a page texture is created or replaced. */
  get generation(): number {
    return this.#generation;
  }

  /** A slot for a new tile, preferably in `prefer`. Its page grows first when it must. */
  allocate(prefer?: number): number {
    const code = this.allocator.allocate(prefer);
    this.#ensure(slotPage(code));
    return code;
  }

  free(code: number): void {
    this.allocator.free(code);
    this.#stale.delete(code);
  }

  /** Forgets every slot. The page textures stay for reuse. */
  reset(): void {
    this.allocator.reset();
    this.#stale.clear();
  }

  /** Uploads a whole tile (RGBA8, straight alpha) into a slot. */
  write(code: number, pixels: Uint8Array): void {
    const page = this.#page(code);
    this.#device.queue.writeTexture(
      { texture: page.texture, origin: [0, 0, slotSlice(code)] },
      pixels as Uint8Array<ArrayBuffer>,
      { bytesPerRow: TILE_ROW_BYTES, rowsPerImage: TILE_SIZE },
      [TILE_SIZE, TILE_SIZE, 1],
    );
    this.#stale.add(code);
  }

  /** Uploads part of a tile (RGBA8 rows of `rect.width` pixels) into a slot at `rect`. */
  writeRect(code: number, pixels: Uint8Array, rect: Rect): void {
    const page = this.#page(code);
    this.#device.queue.writeTexture(
      { texture: page.texture, origin: [rect.x, rect.y, slotSlice(code)] },
      pixels as Uint8Array<ArrayBuffer>,
      { bytesPerRow: rect.width * 4, rowsPerImage: rect.height },
      [rect.width, rect.height, 1],
    );
    this.#stale.add(code);
  }

  /** Copies a tile's level 0 from a buffer of packed RGBA8 words, at `offset` bytes. */
  copyFromBuffer(
    encoder: GPUCommandEncoder,
    buffer: GPUBuffer,
    offset: number,
    code: number,
  ): void {
    encoder.copyBufferToTexture(
      { buffer, offset, bytesPerRow: TILE_ROW_BYTES, rowsPerImage: TILE_SIZE },
      { texture: this.#page(code).texture, origin: [0, 0, slotSlice(code)] },
      [TILE_SIZE, TILE_SIZE, 1],
    );
    this.#stale.add(code);
  }

  /** Copies a tile's level 0 into a buffer, at `offset` bytes. */
  copyToBuffer(encoder: GPUCommandEncoder, code: number, buffer: GPUBuffer, offset: number): void {
    encoder.copyTextureToBuffer(
      { texture: this.#page(code).texture, origin: [0, 0, slotSlice(code)] },
      { buffer, offset, bytesPerRow: TILE_ROW_BYTES, rowsPerImage: TILE_SIZE },
      [TILE_SIZE, TILE_SIZE, 1],
    );
  }

  /** Every mip level and slice of a page, for sampling. */
  sampledView(page: number): GPUTextureView {
    const entry = this.#pages[page];
    if (!entry) throw new Error(`Page ${page} does not exist.`);
    return entry.sampled;
  }

  /** Rebuilds the mip chains of every slot written since the last flush. */
  flushMips(encoder: GPUCommandEncoder): void {
    if (this.#stale.size === 0) return;
    const byPage = new Map<number, number[]>();
    for (const code of this.#stale) {
      const list = byPage.get(slotPage(code)) ?? [];
      list.push(slotSlice(code));
      byPage.set(slotPage(code), list);
    }
    this.#stale.clear();
    const device = this.#device;
    const buffers: GPUBuffer[] = [];
    const pass = encoder.beginComputePass({ label: "v2 tile mips" });
    pass.setPipeline(this.#mipPipeline);
    for (const [pageIndex, slices] of byPage) {
      const page = this.#pages[pageIndex];
      if (!page) continue;
      const list = device.createBuffer({
        label: "v2 mip slices",
        size: Math.max(16, slices.length * 4),
        usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
      });
      buffers.push(list);
      device.queue.writeBuffer(list, 0, new Uint32Array(slices));
      for (let level = 0; level < TILE_MIPS - 1; level++) {
        const src = page.levels[level];
        const dst = page.levels[level + 1];
        if (!src || !dst) break;
        pass.setBindGroup(
          0,
          device.createBindGroup({
            layout: this.#mipPipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: src },
              { binding: 1, resource: dst },
              { binding: 2, resource: { buffer: list } },
            ],
          }),
        );
        const groups = Math.ceil((TILE_SIZE >> (level + 1)) / 8);
        pass.dispatchWorkgroups(groups, groups, slices.length);
      }
    }
    pass.end();
    this.#garbage.push(...buffers);
  }

  /** Frees the temporary buffers of the last flush. Call after submitting its encoder. */
  afterSubmit(): void {
    for (const buffer of this.#garbage) buffer.destroy();
    this.#garbage.length = 0;
  }

  destroy(): void {
    for (const page of this.#pages) page.texture.destroy();
    this.#pages.length = 0;
  }

  #page(code: number): Page {
    const page = this.#pages[slotPage(code)];
    if (!page) throw new Error(`Slot ${code} has no page.`);
    return page;
  }

  /** Creates the page, or grows it by copying every level into a larger texture. */
  #ensure(index: number): void {
    const capacity = this.allocator.capacity(index);
    const existing = this.#pages[index];
    if (existing && existing.capacity >= capacity) return;
    const texture = this.#device.createTexture({
      label: `v2 tile page ${index}`,
      size: [TILE_SIZE, TILE_SIZE, capacity],
      format: "rgba8unorm",
      mipLevelCount: TILE_MIPS,
      dimension: "2d",
      usage: PAGE_USAGE,
    });
    if (existing) {
      const encoder = this.#device.createCommandEncoder({ label: "v2 page growth" });
      for (let level = 0; level < TILE_MIPS; level++) {
        const size = Math.max(1, TILE_SIZE >> level);
        encoder.copyTextureToTexture(
          { texture: existing.texture, mipLevel: level },
          { texture, mipLevel: level },
          [size, size, existing.capacity],
        );
      }
      this.#device.queue.submit([encoder.finish()]);
      existing.texture.destroy();
    }
    this.#generation += 1;
    this.#pages[index] = {
      texture,
      capacity,
      generation: this.#generation,
      sampled: texture.createView({ dimension: "2d-array" }),
      levels: Array.from({ length: TILE_MIPS }, (_, level) =>
        texture.createView({ dimension: "2d-array", baseMipLevel: level, mipLevelCount: 1 }),
      ),
    };
  }
}
