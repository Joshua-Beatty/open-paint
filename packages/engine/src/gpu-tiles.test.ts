import { rgba8, TiledPixelStore } from "@openpaint/document";
import { describe, expect, it } from "vitest";
import { FakeDevice } from "./fake-gpu";
import { GpuTileCache } from "./gpu-tiles";

const RED = rgba8(255, 0, 0, 255);

describe("GpuTileCache", () => {
  it("uploads allocated tiles of tracked stores once a device is set", () => {
    const store = new TiledPixelStore(600, 300);
    store.setPixel(10, 10, RED);
    store.setPixel(300, 10, RED);
    const cache = new GpuTileCache();
    cache.track(store);
    expect(cache.texture(store, 0, 0)).toBeUndefined();

    const device = new FakeDevice(undefined);
    cache.setDevice(device.gpu);
    expect(device.textures.map((t) => t.descriptor.label)).toEqual(["tile 0,0", "tile 1,0"]);
    expect(device.textures[0]?.descriptor).toMatchObject({
      size: [256, 256],
      format: "rgba8unorm",
    });
    expect(device.writes.map((w) => w.data)).toEqual([
      store.getTile(0, 0)?.data,
      store.getTile(1, 0)?.data,
    ]);
    expect(cache.texture(store, 1, 0)).toBe(device.textures[1]);
    expect(cache.texture(store, 2, 0)).toBeUndefined();
  });

  it("re-uploads changed tiles and drops textures of freed tiles", () => {
    const store = new TiledPixelStore(600, 300);
    store.setPixel(10, 10, RED);
    const device = new FakeDevice(undefined);
    const cache = new GpuTileCache();
    cache.setDevice(device.gpu);
    cache.track(store);
    const first = cache.texture(store, 0, 0);

    store.setPixel(300, 10, RED);
    store.clear(store.tileBounds(0, 0));
    cache.upload(store, store.takeDirtyTiles());
    expect(first).toMatchObject({ destroyed: true });
    expect(cache.texture(store, 0, 0)).toBeUndefined();
    expect(cache.texture(store, 1, 0)).toBeDefined();

    cache.untrack(store);
    expect(device.textures.every((t) => t.destroyed)).toBe(true);
  });

  it("rebuilds every texture from the CPU tiles on a new device", () => {
    const store = new TiledPixelStore(300, 300);
    store.fill(RED);
    const cache = new GpuTileCache();
    const lost = new FakeDevice(undefined);
    cache.setDevice(lost.gpu);
    cache.track(store);
    expect(lost.textures).toHaveLength(4);

    const fresh = new FakeDevice(undefined);
    cache.setDevice(fresh.gpu);
    expect(lost.textures.every((t) => t.destroyed)).toBe(true);
    expect(fresh.textures).toHaveLength(4);
    expect(fresh.writes).toHaveLength(4);
    expect(cache.device).toBe(fresh.gpu);

    cache.setDevice(undefined);
    expect(fresh.textures.every((t) => t.destroyed)).toBe(true);
    expect(cache.texture(store, 0, 0)).toBeUndefined();
  });
});
