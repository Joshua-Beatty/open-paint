import { TILE_SIZE, type TileCoord, type TiledPixelStore } from "@openpaint/document";
import { TextureUsage } from "./gpu-device";

/**
 * GPU texture mirror of CPU pixel-store tiles. The CPU tiles stay authoritative (WEB-GPU-05), so
 * the textures can always be rebuilt: `setDevice` re-uploads every tracked store, which is how the
 * engine recovers from device loss.
 */
export class GpuTileCache {
  #device: GPUDevice | undefined;
  readonly #textures = new Map<TiledPixelStore, Map<string, GPUTexture>>();

  get device(): GPUDevice | undefined {
    return this.#device;
  }

  /** The texture holding a tile, or undefined when the tile is unallocated (transparent). */
  texture(store: TiledPixelStore, tx: number, ty: number): GPUTexture | undefined {
    return this.#textures.get(store)?.get(`${tx},${ty}`);
  }

  /** Starts mirroring `store` and uploads its allocated tiles. */
  track(store: TiledPixelStore): void {
    if (this.#textures.has(store)) return;
    this.#textures.set(store, new Map());
    this.upload(store, store.allocatedTiles());
  }

  untrack(store: TiledPixelStore): void {
    for (const texture of this.#textures.get(store)?.values() ?? []) texture.destroy();
    this.#textures.delete(store);
  }

  /** Copies the given tiles of a tracked store to the GPU; freed tiles drop their texture. */
  upload(store: TiledPixelStore, tiles: readonly TileCoord[]): void {
    const textures = this.#textures.get(store);
    const device = this.#device;
    if (!textures || !device) return;
    for (const { tx, ty } of tiles) {
      const key = `${tx},${ty}`;
      const tile = store.getTile(tx, ty);
      let texture = textures.get(key);
      if (!tile) {
        texture?.destroy();
        textures.delete(key);
        continue;
      }
      if (!texture) {
        texture = device.createTexture({
          label: `tile ${key}`,
          size: [TILE_SIZE, TILE_SIZE],
          format: "rgba8unorm",
          usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
        });
        textures.set(key, texture);
      }
      device.queue.writeTexture({ texture }, tile.data, { bytesPerRow: TILE_SIZE * 4 }, [
        TILE_SIZE,
        TILE_SIZE,
      ]);
    }
  }

  /**
   * Switches to `device` (undefined on the CPU backend), dropping all textures and re-uploading
   * every tracked store from its CPU tiles.
   */
  setDevice(device: GPUDevice | undefined): void {
    for (const textures of this.#textures.values()) {
      for (const texture of textures.values()) texture.destroy();
      textures.clear();
    }
    this.#device = device;
    for (const store of this.#textures.keys()) this.upload(store, store.allocatedTiles());
  }
}
