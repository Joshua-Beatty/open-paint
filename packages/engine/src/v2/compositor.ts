import { identityPlan, POSTERIZE_OP, pixelAdjustment } from "@openpaint/effects";
import type { LiveFilter } from "../composite";
import { PARAMS_BYTES as ADJUST_PARAMS_BYTES, paramsBytes } from "../gpu-adjustment";
import { BufferUsage, TextureUsage } from "../gpu-device";
import {
  COMPOSITE_TILE_SIZE,
  CompositeCache,
  type CompositeDraw,
  type CompositeWork,
} from "./composite-plan";
import type { GpuTilePool } from "./tile-pool";
import type { BuiltTable } from "./tile-table";
import { COMPOSITE_PAGES, COMPOSITE_V2_WGSL } from "./wgsl";

/** Most layers one dispatch blends before the stack is split. */
export const LAYERS_PER_CHUNK = 64;
/** Bytes of the composite shader's `Params` uniform, padded to the dynamic offset stride. */
const PARAMS_BYTES = 80;
const PARAMS_STRIDE = 256;
const GROUPS = Math.ceil(COMPOSITE_TILE_SIZE / 8);
/** Bytes of the shader's `Live` uniform: the region, then the flags. */
const LIVE_REGION_BYTES = 32;
/** `GPUShaderStage.COMPUTE`; the DOM lib types WebGPU interfaces but not these globals. */
const COMPUTE_STAGE = 0x4;

/** A run of active layers (`start`, `count`) whose tiles live in at most `COMPOSITE_PAGES` pages. */
export interface LayerChunk {
  readonly start: number;
  readonly count: number;
  readonly pages: readonly number[];
}

/**
 * Splits the active layers, bottom to top, into runs that one composite dispatch can blend: at
 * most `LAYERS_PER_CHUNK` layers whose tiles use at most `COMPOSITE_PAGES` pages. A layer whose
 * tiles span more pages than that is an error (an image of thousands of tiles per layer).
 */
export function chunkLayers(pages: readonly ReadonlySet<number>[]): LayerChunk[] {
  const chunks: LayerChunk[] = [];
  let start = 0;
  let used = new Set<number>();
  pages.forEach((layerPages, index) => {
    if (layerPages.size > COMPOSITE_PAGES) {
      throw new RangeError(
        `A layer spans ${layerPages.size} tile pages; at most ${COMPOSITE_PAGES}.`,
      );
    }
    const merged = new Set([...used, ...layerPages]);
    if (index > start && (merged.size > COMPOSITE_PAGES || index - start >= LAYERS_PER_CHUNK)) {
      chunks.push({ start, count: index - start, pages: [...used] });
      start = index;
      used = new Set(layerPages);
    } else {
      used = merged;
    }
  });
  chunks.push({ start, count: pages.length - start, pages: [...used] });
  return chunks;
}

/**
 * The v2 compositor. It blends the visible composite tiles from the
 * GPU document's layer tiles at the view's mip level, with the WGSL twin of the Rust reference,
 * and caches each result in a slot of a texture array until a layer tile under it changes.
 */
export class GpuCompositorV2 {
  readonly cache = new CompositeCache();
  readonly #device: GPUDevice;
  readonly #pool: GpuTilePool;
  readonly #pipeline: GPUComputePipeline;
  readonly #layout: GPUBindGroupLayout;
  readonly #scratch: readonly [GPUTexture, GPUTexture];
  readonly #emptyBase: GPUTexture;
  readonly #emptyPage: GPUTexture;
  #slots: GPUTexture | undefined;
  #slotCapacity = 0;
  #slotsView: GPUTextureView | undefined;
  #table: GPUBuffer | undefined;
  #layers: GPUBuffer | undefined;
  #uploaded: BuiltTable | undefined;
  #params: GPUBuffer | undefined;
  #paramsCapacity = 0;
  readonly #liveParams: GPUBuffer;
  readonly #liveRegion: GPUBuffer;
  #liveCoverage: GPUBuffer;
  /** The live filter the buffers hold, and the coverage they hold. */
  #live: LiveFilter | undefined;
  #liveCoverageBytes: Uint8Array | undefined;

  /**
   * Results are premultiplied for presentation. `premultiply: false` keeps them straight, which
   * the golden checks compare with the CPU compositor.
   */
  constructor(
    device: GPUDevice,
    pool: GpuTilePool,
    readonly options: { readonly premultiply?: boolean } = {},
  ) {
    this.#device = device;
    this.#pool = pool;
    const module = device.createShaderModule({ label: "v2 composite", code: COMPOSITE_V2_WGSL });
    this.#layout = device.createBindGroupLayout({
      label: "v2 composite",
      entries: [
        {
          binding: 0,
          visibility: COMPUTE_STAGE,
          buffer: { type: "uniform", hasDynamicOffset: true },
        },
        { binding: 1, visibility: COMPUTE_STAGE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: COMPUTE_STAGE, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: COMPUTE_STAGE, texture: { sampleType: "float" } },
        {
          binding: 4,
          visibility: COMPUTE_STAGE,
          storageTexture: { access: "write-only", format: "rgba8unorm" },
        },
        ...Array.from({ length: COMPOSITE_PAGES }, (_, k) => ({
          binding: 5 + k,
          visibility: COMPUTE_STAGE,
          texture: { sampleType: "float", viewDimension: "2d-array" } as const,
        })),
        { binding: 13, visibility: COMPUTE_STAGE, buffer: { type: "uniform" } },
        { binding: 14, visibility: COMPUTE_STAGE, buffer: { type: "uniform" } },
        { binding: 15, visibility: COMPUTE_STAGE, buffer: { type: "read-only-storage" } },
      ],
    });
    this.#liveParams = device.createBuffer({
      label: "v2 live filter adjustment",
      size: ADJUST_PARAMS_BYTES,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    this.#liveRegion = device.createBuffer({
      label: "v2 live filter region",
      size: LIVE_REGION_BYTES,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    this.#liveCoverage = this.#sized(undefined, 4, "v2 live filter coverage");
    this.#pipeline = device.createComputePipeline({
      label: "v2 composite",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.#layout] }),
      compute: { module, entryPoint: "composite" },
    });
    const scratch = (index: number) =>
      device.createTexture({
        label: `v2 composite scratch ${index}`,
        size: [COMPOSITE_TILE_SIZE, COMPOSITE_TILE_SIZE],
        format: "rgba8unorm",
        usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING,
      });
    this.#scratch = [scratch(0), scratch(1)];
    this.#emptyBase = device.createTexture({
      label: "v2 composite empty base",
      size: [1, 1],
      format: "rgba8unorm",
      usage: TextureUsage.TEXTURE_BINDING,
    });
    this.#emptyPage = device.createTexture({
      label: "v2 composite empty page",
      size: [1, 1, 1],
      format: "rgba8unorm",
      usage: TextureUsage.TEXTURE_BINDING,
    });
  }

  /** The texture array of blended tiles (premultiplied), for the presenter. */
  get slots(): GPUTextureView | undefined {
    return this.#slotsView;
  }

  /** The texture behind `slots`, for reading results back. */
  get texture(): GPUTexture | undefined {
    return this.#slots;
  }

  /**
   * Sets the live filter that layers marked in the table are drawn through (FX-FW-PREVIEW-01).
   * Uploads its adjustment and region when they changed, and its coverage when that changed. The
   * caller re-blends the tiles (the document reports a stack change).
   */
  setLive(live: LiveFilter | undefined): void {
    if (live === this.#live) return;
    this.#live = live;
    if (live === undefined) return;
    const adjustment = pixelAdjustment(live.effectId);
    // Posterize with no levels leaves every pixel as it is, for an effect that is not per pixel.
    const plan = adjustment?.plan(live.params) ?? identityPlan(POSTERIZE_OP);
    this.#device.queue.writeBuffer(this.#liveParams, 0, paramsBytes(0, 0, 0, plan));
    const { region, coverage } = live;
    this.#device.queue.writeBuffer(
      this.#liveRegion,
      0,
      new Uint32Array([region.x, region.y, region.width, region.height, coverage ? 1 : 0, 0, 0, 0]),
    );
    if (coverage === undefined || coverage === this.#liveCoverageBytes) return;
    this.#liveCoverageBytes = coverage;
    const words = new Uint8Array(Math.ceil(coverage.length / 4) * 4);
    words.set(coverage);
    this.#liveCoverage = this.#sized(
      this.#liveCoverage,
      words.byteLength,
      "v2 live filter coverage",
    );
    this.#device.queue.writeBuffer(this.#liveCoverage, 0, words);
  }

  /**
   * Blends whatever `draws` need: tiles not cached yet and tiles marked dirty. Returns each draw's
   * slot. `extent` is the image size; `table` is the GPU document's current table.
   */
  encode(
    encoder: GPUCommandEncoder,
    draws: readonly CompositeDraw[],
    table: BuiltTable,
    tilesX: number,
    extent: { width: number; height: number },
  ): number[] {
    let { slots, work } = this.cache.prepare(draws);
    if (this.cache.slotCount > this.#slotCapacity) {
      this.#growSlots(this.cache.slotCount);
      this.cache.invalidateAll();
      ({ slots, work } = this.cache.prepare(draws));
    }
    if (work.length > 0) this.#blend(encoder, work, table, tilesX, extent);
    return slots;
  }

  destroy(): void {
    for (const texture of [...this.#scratch, this.#emptyBase, this.#emptyPage]) texture.destroy();
    this.#slots?.destroy();
    this.#table?.destroy();
    this.#layers?.destroy();
    this.#params?.destroy();
    this.#liveParams.destroy();
    this.#liveRegion.destroy();
    this.#liveCoverage.destroy();
  }

  #blend(
    encoder: GPUCommandEncoder,
    work: readonly CompositeWork[],
    table: BuiltTable,
    tilesX: number,
    extent: { width: number; height: number },
  ): void {
    const device = this.#device;
    this.#upload(table);
    const chunks = chunkLayers(table.pages);
    const dispatches = work.length * chunks.length;
    this.#ensureParams(dispatches);
    const params = new ArrayBuffer(dispatches * PARAMS_STRIDE);
    const view = new DataView(params);
    const groups: GPUBindGroup[] = [];
    const slots = this.#slots as GPUTexture;
    let index = 0;
    for (const { draw, slot } of work) {
      const level = draw.level;
      chunks.forEach((chunk, chunkIndex) => {
        const first = chunkIndex === 0;
        const last = chunkIndex === chunks.length - 1;
        const base = first ? this.#emptyBase : (this.#scratch[(chunkIndex - 1) % 2] as GPUTexture);
        const out = last
          ? slots.createView({ dimension: "2d", baseArrayLayer: slot, arrayLayerCount: 1 })
          : (this.#scratch[chunkIndex % 2] as GPUTexture).createView();
        const offset = index * PARAMS_STRIDE;
        const scale = 2 ** level;
        const words = [
          draw.cx * COMPOSITE_TILE_SIZE,
          draw.cy * COMPOSITE_TILE_SIZE,
          level,
          chunk.start,
          chunk.count,
          tilesX,
          (first ? 0 : 1) | (last && this.options.premultiply !== false ? 2 : 0),
          0,
          // The pixels the image covers completely at this level; the shader repeats the last ones.
          Math.max(1, Math.floor(extent.width / scale)),
          Math.max(1, Math.floor(extent.height / scale)),
          0,
          0,
        ];
        words.forEach((word, i) => {
          view.setUint32(offset + i * 4, word, true);
        });
        for (let k = 0; k < COMPOSITE_PAGES; k++) {
          view.setUint32(offset + 48 + k * 4, chunk.pages[k] ?? 0xffff_ffff, true);
        }
        groups.push(this.#bindGroup(chunk, base.createView(), out));
        index += 1;
      });
    }
    device.queue.writeBuffer(this.#params as GPUBuffer, 0, params);
    const pass = encoder.beginComputePass({ label: "v2 composite" });
    pass.setPipeline(this.#pipeline);
    groups.forEach((group, i) => {
      pass.setBindGroup(0, group, [i * PARAMS_STRIDE]);
      pass.dispatchWorkgroups(GROUPS, GROUPS);
    });
    pass.end();
  }

  #bindGroup(chunk: LayerChunk, base: GPUTextureView, out: GPUTextureView): GPUBindGroup {
    const pages: GPUBindGroupEntry[] = [];
    for (let k = 0; k < COMPOSITE_PAGES; k++) {
      const page = chunk.pages[k];
      pages.push({
        binding: 5 + k,
        resource:
          page === undefined
            ? this.#emptyPage.createView({ dimension: "2d-array" })
            : this.#pool.sampledView(page),
      });
    }
    return this.#device.createBindGroup({
      layout: this.#layout,
      entries: [
        { binding: 0, resource: { buffer: this.#params as GPUBuffer, size: PARAMS_BYTES } },
        { binding: 1, resource: { buffer: this.#layers as GPUBuffer } },
        { binding: 2, resource: { buffer: this.#table as GPUBuffer } },
        { binding: 3, resource: base },
        { binding: 4, resource: out },
        ...pages,
        { binding: 13, resource: { buffer: this.#liveParams } },
        { binding: 14, resource: { buffer: this.#liveRegion } },
        { binding: 15, resource: { buffer: this.#liveCoverage } },
      ],
    });
  }

  /** Uploads the slot table and layer list when they changed since the last blend. */
  #upload(table: BuiltTable): void {
    if (this.#uploaded === table) return;
    this.#uploaded = table;
    this.#table = this.#sized(this.#table, table.table.byteLength, "v2 composite table");
    this.#layers = this.#sized(this.#layers, table.layers.byteLength, "v2 composite layers");
    this.#device.queue.writeBuffer(this.#table, 0, table.table as Uint32Array<ArrayBuffer>);
    this.#device.queue.writeBuffer(this.#layers, 0, table.layers as Uint32Array<ArrayBuffer>);
  }

  #sized(buffer: GPUBuffer | undefined, bytes: number, label: string): GPUBuffer {
    if (buffer && buffer.size >= bytes) return buffer;
    buffer?.destroy();
    return this.#device.createBuffer({
      label,
      size: Math.max(256, 2 ** Math.ceil(Math.log2(bytes))),
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
    });
  }

  #ensureParams(dispatches: number): void {
    if (dispatches <= this.#paramsCapacity) return;
    this.#params?.destroy();
    this.#paramsCapacity = Math.max(dispatches, this.#paramsCapacity * 2, 16);
    this.#params = this.#device.createBuffer({
      label: "v2 composite params",
      size: this.#paramsCapacity * PARAMS_STRIDE,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
  }

  #growSlots(needed: number): void {
    this.#slots?.destroy();
    this.#slotCapacity = Math.max(needed, this.#slotCapacity * 2, 16);
    this.#slots = this.#device.createTexture({
      label: "v2 composite tiles",
      size: [COMPOSITE_TILE_SIZE, COMPOSITE_TILE_SIZE, this.#slotCapacity],
      format: "rgba8unorm",
      usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_SRC,
    });
    this.#slotsView = this.#slots.createView({ dimension: "2d-array" });
  }
}
