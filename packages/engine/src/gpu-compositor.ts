import { type Rect, TILE_SIZE } from "@openpaint/document";
import { activeLayers, type CompositeDocument, tilesCovering } from "./composite";
import { COMPOSITE_WGSL, PRESENT_WGSL } from "./composite-wgsl";
import { BufferUsage, TextureUsage } from "./gpu-device";
import type { GpuTileCache } from "./gpu-tiles";

/** Workgroups per tile edge; the shaders use 8x8 workgroups. */
const GROUPS = Math.ceil(TILE_SIZE / 8);
/** Bytes of the present shader's `Frame` uniform (rect + canvas size, padded to 32). */
const FRAME_BYTES = 32;
/** Bytes of the blend shader's `Layer` uniform (mode, opacity, padded to 16). */
const LAYER_BYTES = 16;

/** A finished composite tile, positioned in document pixels. */
export interface ComposedTile {
  readonly x: number;
  readonly y: number;
  readonly texture: GPUTexture;
  readonly frame: GPUBuffer;
}

interface CompositeTile {
  /**
   * Ping-pong pair. WebGPU has no read-write storage for rgba8unorm, so each layer reads one
   * texture and writes the other.
   */
  readonly textures: readonly [GPUTexture, GPUTexture];
  readonly frame: GPUBuffer;
}

/**
 * WebGPU compositor (ARC-02-01, ARC-03-03): blends the layer tiles of a document bottom to top
 * with the WGSL twin of the Rust reference (DOC-BLD-02), then draws the composited tiles into a
 * canvas. Layer tiles come from the tile cache, so only dirty tiles are ever uploaded.
 */
export class GpuCompositor {
  readonly #device: GPUDevice;
  readonly #tiles: GpuTileCache;
  readonly #clearPipeline: GPUComputePipeline;
  readonly #blendPipeline: GPUComputePipeline;
  readonly #presentPipeline: GPURenderPipeline;
  readonly #layerParams: GPUBuffer[] = [];
  readonly #composites = new Map<string, CompositeTile>();

  constructor(device: GPUDevice, tiles: GpuTileCache, format: GPUTextureFormat) {
    this.#device = device;
    this.#tiles = tiles;
    const compute = device.createShaderModule({ label: "composite", code: COMPOSITE_WGSL });
    this.#clearPipeline = device.createComputePipeline({
      label: "composite clear",
      layout: "auto",
      compute: { module: compute, entryPoint: "clear" },
    });
    this.#blendPipeline = device.createComputePipeline({
      label: "composite blend",
      layout: "auto",
      compute: { module: compute, entryPoint: "composite" },
    });
    const present = device.createShaderModule({ label: "present", code: PRESENT_WGSL });
    this.#presentPipeline = device.createRenderPipeline({
      label: "present tile",
      layout: "auto",
      vertex: { module: present, entryPoint: "vs" },
      fragment: { module: present, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
  }

  /**
   * Composites every tile covering `region` from the active layers of `doc`. Layer tiles that are
   * not on the GPU (unallocated on the CPU side) contribute nothing.
   */
  compose(doc: CompositeDocument, region: Rect): ComposedTile[] {
    const device = this.#device;
    const layers = activeLayers(doc);
    const coords = tilesCovering(region);
    this.#release(new Set(coords.map(({ tx, ty }) => keyOf(tx, ty))));

    layers.forEach((layer, index) => {
      const data = new Uint32Array([layer.mode, layer.opacity, 0, 0]);
      device.queue.writeBuffer(this.#layerBuffer(index), 0, data);
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    const composed: ComposedTile[] = [];
    for (const { tx, ty } of coords) {
      const tile = this.#composite(tx, ty);
      pass.setPipeline(this.#clearPipeline);
      pass.setBindGroup(
        0,
        this.#bindGroup(this.#clearPipeline, [
          { binding: 3, resource: tile.textures[0].createView() },
        ]),
      );
      pass.dispatchWorkgroups(GROUPS, GROUPS);

      let current: 0 | 1 = 0;
      layers.forEach((layer, index) => {
        const source = this.#tiles.texture(layer.store, tx, ty);
        if (!source) return;
        const next: 0 | 1 = current === 0 ? 1 : 0;
        pass.setPipeline(this.#blendPipeline);
        pass.setBindGroup(
          0,
          this.#bindGroup(this.#blendPipeline, [
            { binding: 0, resource: { buffer: this.#layerBuffer(index) } },
            { binding: 1, resource: source.createView() },
            { binding: 2, resource: tile.textures[current].createView() },
            { binding: 3, resource: tile.textures[next].createView() },
          ]),
        );
        pass.dispatchWorkgroups(GROUPS, GROUPS);
        current = next;
      });
      composed.push({
        x: tx * TILE_SIZE,
        y: ty * TILE_SIZE,
        texture: tile.textures[current],
        frame: tile.frame,
      });
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
    return composed;
  }

  /** Draws composited tiles into `target` (a `width` x `height` canvas) and clears the rest. */
  draw(
    target: GPUTextureView,
    width: number,
    height: number,
    tiles: readonly ComposedTile[],
  ): void {
    const device = this.#device;
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: target, clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" },
      ],
    });
    pass.setPipeline(this.#presentPipeline);
    for (const tile of tiles) {
      device.queue.writeBuffer(
        tile.frame,
        0,
        new Float32Array([tile.x, tile.y, TILE_SIZE, TILE_SIZE, width, height, 0, 0]),
      );
      pass.setBindGroup(
        0,
        this.#bindGroup(this.#presentPipeline, [
          { binding: 0, resource: { buffer: tile.frame } },
          { binding: 1, resource: tile.texture.createView() },
        ]),
      );
      pass.draw(6);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  #composite(tx: number, ty: number): CompositeTile {
    const key = keyOf(tx, ty);
    const existing = this.#composites.get(key);
    if (existing) return existing;
    const device = this.#device;
    const texture = (index: number) =>
      device.createTexture({
        label: `composite ${key} ${index}`,
        size: [TILE_SIZE, TILE_SIZE],
        format: "rgba8unorm",
        usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_SRC,
      });
    const tile: CompositeTile = {
      textures: [texture(0), texture(1)],
      frame: device.createBuffer({
        label: `present ${key}`,
        size: FRAME_BYTES,
        usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
      }),
    };
    this.#composites.set(key, tile);
    return tile;
  }

  /** Frees composite tiles outside the region that was just composed. */
  #release(keep: ReadonlySet<string>): void {
    for (const [key, tile] of this.#composites) {
      if (keep.has(key)) continue;
      for (const texture of tile.textures) texture.destroy();
      tile.frame.destroy();
      this.#composites.delete(key);
    }
  }

  #layerBuffer(index: number): GPUBuffer {
    let buffer = this.#layerParams[index];
    if (!buffer) {
      buffer = this.#device.createBuffer({
        label: `layer ${index}`,
        size: LAYER_BYTES,
        usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
      });
      this.#layerParams[index] = buffer;
    }
    return buffer;
  }

  #bindGroup(
    pipeline: GPUComputePipeline | GPURenderPipeline,
    entries: GPUBindGroupEntry[],
  ): GPUBindGroup {
    return this.#device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
  }
}

function keyOf(tx: number, ty: number): string {
  return `${tx},${ty}`;
}
