import { MemoryAccountant, rect, Surface, TiledPixelStore } from "@openpaint/document";
import type { EffectDescriptor } from "@openpaint/extension-api";
import { describe, expect, it, vi } from "vitest";
import type { EffectBinding } from "./binding";
import { EffectError } from "./errors";
import type { GpuOffloader } from "./gpu-offload";
import { orderTiles, RENDER_TILE_SIZE, renderRegion, tileRects, WRITE_SLICE_MS } from "./render";

function descriptor(id = "test"): EffectDescriptor {
  return {
    id,
    apiVersion: 1,
    label: "effect.gaussianBlur",
    icon: "icon.gaussianBlur",
    category: "effect",
    configurable: false,
    kind: "cpuRegion",
    schema: { properties: [], rules: [], layout: undefined, version: 1, migrations: [] },
  } as unknown as EffectDescriptor;
}

function binding(cpu: (input: Surface) => Surface): EffectBinding<number> {
  return { descriptor: descriptor(), params: () => 0, cpu: (input) => cpu(input) };
}

/** Inverts the color channels and keeps alpha. */
function invert(input: Surface): Surface {
  const data = new Uint8ClampedArray(input.data);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255 - (data[i] ?? 0);
    data[i + 1] = 255 - (data[i + 1] ?? 0);
    data[i + 2] = 255 - (data[i + 2] ?? 0);
  }
  return new Surface(input.width, input.height, data);
}

function gradient(width: number, height: number): Surface {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data.set([i % 256, (i * 7) % 256, (i * 13) % 256, 255], i * 4);
  }
  return new Surface(width, height, data);
}

function storeWith(surface: Surface, accountant?: MemoryAccountant): TiledPixelStore {
  const store = new TiledPixelStore(surface.width, surface.height, { accountant });
  store.writeRegion(surface, 0, 0);
  return store;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("tile grid", () => {
  it("splits a region along the 256 px store grid, clipped to the region", () => {
    expect(tileRects(rect(250, 0, 20, 10))).toEqual([rect(250, 0, 6, 10), rect(256, 0, 14, 10)]);
    expect(RENDER_TILE_SIZE).toBe(256);
  });

  it("puts the tiles nearest the priority rectangle first", () => {
    const tiles = [rect(0, 0, 256, 256), rect(256, 0, 256, 256)];
    expect(orderTiles(tiles, rect(300, 10, 20, 20))[0]).toEqual(rect(256, 0, 256, 256));
    expect(orderTiles(tiles)).toEqual(tiles);
  });
});

/** A clock that moves one write slice on every read, so a render yields after every tile. */
function ticking(): () => number {
  let now = 0;
  return () => (now += WRITE_SLICE_MS);
}

describe("renderRegion", () => {
  it("writes the effect into the region only", async () => {
    const source = gradient(8, 8);
    const store = storeWith(source);
    const region = rect(2, 2, 4, 4);
    const outcome = await renderRegion({
      binding: binding(invert),
      params: 0,
      store,
      region,
      original: store.readRegion(region),
      backend: "cpu",
      signal: signal(),
    });
    expect(outcome).toBe("done");
    const inside = (2 * 8 + 2) * 4;
    expect(store.readRegion(rect(2, 2, 1, 1)).data[0]).toBe(255 - (source.data[inside] ?? 0));
    expect([...store.readRegion(rect(0, 0, 1, 1)).data]).toEqual([...source.data.slice(0, 4)]);
    expect([...store.readRegion(rect(7, 7, 1, 1)).data]).toEqual([
      ...source.data.slice((7 * 8 + 7) * 4, (7 * 8 + 7) * 4 + 4),
    ]);
  });

  it("hands the selection coverage to the effect, so analysis can read only selected pixels", async () => {
    const source = gradient(2, 1);
    const store = storeWith(source);
    const coverage = new Uint8Array([0, 255]);
    const seen: (ArrayLike<number> | undefined)[] = [];
    const reading: EffectBinding<number> = {
      descriptor: descriptor(),
      params: () => 0,
      cpu: (input, _params, selection) => {
        seen.push(selection);
        return invert(input);
      },
    };
    await renderRegion({
      binding: reading,
      params: 0,
      store,
      region: rect(0, 0, 2, 1),
      original: source,
      coverage,
      backend: "cpu",
      signal: signal(),
    });
    expect(seen).toEqual([coverage]);
  });

  it("keeps the original where coverage is 0 and takes the effect where it is 255", async () => {
    const source = gradient(2, 1);
    const store = storeWith(source);
    await renderRegion({
      binding: binding(invert),
      params: 0,
      store,
      region: rect(0, 0, 2, 1),
      original: source,
      coverage: new Uint8Array([0, 255]),
      backend: "cpu",
      signal: signal(),
    });
    const out = store.readRegion(rect(0, 0, 2, 1));
    expect([...out.data.slice(0, 4)]).toEqual([...source.data.slice(0, 4)]);
    expect([...out.data.slice(4, 8)]).toEqual([...invert(source).data.slice(4, 8)]);
  });

  it("writes the effect's output unmixed when clipsOutput is off, so it masks itself", async () => {
    const source = gradient(2, 1);
    const store = storeWith(source);
    const coverage = new Uint8Array([0, 255]);
    const seen: (ArrayLike<number> | undefined)[] = [];
    const selfMasked: EffectBinding<number> = {
      descriptor: descriptor(),
      params: () => 0,
      cpu: (input, _params, selection) => {
        seen.push(selection);
        return invert(input);
      },
    };
    await renderRegion({
      binding: selfMasked,
      params: 0,
      store,
      region: rect(0, 0, 2, 1),
      original: source,
      coverage,
      clipsOutput: false,
      backend: "cpu",
      signal: signal(),
    });
    expect(seen).toEqual([coverage]);
    expect([...store.readRegion(rect(0, 0, 2, 1)).data]).toEqual([...invert(source).data]);
  });

  it("uses the GPU implementation when the backend asks for it and it exists", async () => {
    const source = gradient(4, 4);
    const store = storeWith(source);
    const gpu = vi.fn(async (input: Surface) => new Surface(input.width, input.height));
    const cpu = vi.fn(invert);
    const withGpu: EffectBinding<number> = { ...binding(cpu), gpu };
    await renderRegion({
      binding: withGpu,
      params: 0,
      store,
      region: rect(0, 0, 4, 4),
      original: source,
      backend: "gpu",
      signal: signal(),
    });
    expect(gpu).toHaveBeenCalledOnce();
    expect(cpu).not.toHaveBeenCalled();
    expect(store.readRegion(rect(0, 0, 1, 1)).data[0]).toBe(0);
  });

  it("falls back to the CPU and logs when the GPU implementation fails", async () => {
    const source = gradient(4, 4);
    const store = storeWith(source);
    const log = vi.fn();
    const withGpu: EffectBinding<number> = {
      ...binding(invert),
      gpu: async () => {
        throw new Error("no device");
      },
    };
    await renderRegion({
      binding: withGpu,
      params: 0,
      store,
      region: rect(0, 0, 4, 4),
      original: source,
      backend: "gpu",
      log,
      signal: signal(),
    });
    expect(log).toHaveBeenCalledOnce();
    expect(store.readRegion(rect(0, 0, 4, 4)).data[0]).toBe(255 - (source.data[0] ?? 0));
  });

  it("runs on the GPU offloader before the binding's own GPU code, with the CPU as fallback", async () => {
    const source = gradient(4, 4);
    const store = storeWith(source);
    const own = vi.fn(async (input: Surface) => new Surface(input.width, input.height));
    const run = vi.fn(async (_binding: unknown, input: Surface) => {
      const out = new Surface(input.width, input.height);
      out.data.fill(7);
      return out;
    });
    const gpu: GpuOffloader = { canRun: () => true, run: run as GpuOffloader["run"] };
    await renderRegion({
      binding: { ...binding(invert), gpu: own },
      params: 0,
      store,
      region: rect(0, 0, 4, 4),
      original: source,
      backend: "gpu",
      gpu,
      signal: signal(),
    });
    expect(run).toHaveBeenCalledOnce();
    expect(own).not.toHaveBeenCalled();
    expect(store.readRegion(rect(0, 0, 1, 1)).data[0]).toBe(7);

    const log = vi.fn();
    const failing: GpuOffloader = {
      canRun: () => true,
      run: () => Promise.reject(new Error("validation error")),
    };
    await renderRegion({
      binding: binding(invert),
      params: 0,
      store,
      region: rect(0, 0, 4, 4),
      original: source,
      backend: "gpu",
      gpu: failing,
      log,
      signal: signal(),
    });
    expect(log).toHaveBeenCalledOnce();
    expect(store.readRegion(rect(0, 0, 1, 1)).data[0]).toBe(255 - (source.data[0] ?? 0));
  });

  it("does not use the GPU offloader on the CPU backend", async () => {
    const source = gradient(2, 2);
    const run = vi.fn();
    await renderRegion({
      binding: binding(invert),
      params: 0,
      store: storeWith(source),
      region: rect(0, 0, 2, 2),
      original: source,
      backend: "cpu",
      gpu: { canRun: () => true, run },
      signal: signal(),
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("stops a superseded preview at once: no CPU fallback, and its last tiles stay", async () => {
    const source = gradient(4, 4);
    const store = storeWith(source);
    // The previous preview's pixels are on the layer.
    store.writeRegion(invert(source), 0, 0);
    const controller = new AbortController();
    const cpu = vi.fn(invert);
    const gpu: GpuOffloader = {
      canRun: () => true,
      run: (_binding, _input, _params, _coverage, abort) =>
        new Promise((_resolve, reject) => {
          abort.addEventListener("abort", () => reject(new Error("canceled")));
        }),
    };
    const pending = renderRegion({
      binding: binding(cpu),
      params: 0,
      store,
      region: rect(0, 0, 4, 4),
      original: source,
      backend: "gpu",
      gpu,
      restoreOnCancel: false,
      signal: controller.signal,
    });
    controller.abort();
    expect(await pending).toBe("canceled");
    expect(cpu).not.toHaveBeenCalled();
    expect([...store.readRegion(rect(0, 0, 4, 4)).data]).toEqual([...invert(source).data]);
  });

  it("restores the original and throws EffectError when the effect fails", async () => {
    const source = gradient(4, 4);
    const store = storeWith(source);
    const failing: EffectBinding<number> = {
      ...binding(invert),
      cpu: () => {
        throw new Error("bad input");
      },
    };
    const error = await renderRegion({
      binding: failing,
      params: 0,
      store,
      region: rect(0, 0, 4, 4),
      original: source,
      backend: "cpu",
      signal: signal(),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EffectError);
    expect((error as EffectError).failure).toBe("failed");
    expect([...store.readRegion(rect(0, 0, 4, 4)).data]).toEqual([...source.data]);
  });

  it("refuses to start when the scratch memory does not fit, and leaves the layer alone", async () => {
    const source = gradient(4, 4);
    const accountant = new MemoryAccountant(16);
    const store = storeWith(source);
    const before = [...store.readRegion(rect(0, 0, 4, 4)).data];
    const error = await renderRegion({
      binding: binding(invert),
      params: 0,
      store,
      region: rect(0, 0, 4, 4),
      original: source,
      backend: "cpu",
      accountant,
      signal: signal(),
    }).catch((caught: unknown) => caught);
    expect((error as EffectError).failure).toBe("outOfMemory");
    expect([...store.readRegion(rect(0, 0, 4, 4)).data]).toEqual(before);
    expect(accountant.usedBytes).toBe(0);
  });

  it("stops between tiles on cancel and restores the original pixels", async () => {
    const source = gradient(300, 4);
    const store = storeWith(source);
    const controller = new AbortController();
    const outcome = await renderRegion({
      binding: binding((input) => invert(input)),
      params: 0,
      store,
      region: rect(0, 0, 300, 4),
      original: source,
      backend: "cpu",
      signal: controller.signal,
      clock: ticking(),
      yieldToHost: async () => controller.abort(),
    });
    expect(outcome).toBe("canceled");
    expect([...store.readRegion(rect(0, 0, 300, 4)).data]).toEqual([...source.data]);
  });

  it("reports 0 when writing starts and 100 at the end, throttled in between", async () => {
    const source = gradient(600, 4);
    const store = storeWith(source);
    const onProgress = vi.fn();
    await renderRegion({
      binding: binding(invert),
      params: 0,
      store,
      region: rect(0, 0, 600, 4),
      original: source,
      backend: "cpu",
      signal: signal(),
      clock: () => 0,
      onProgress,
    });
    expect(onProgress.mock.calls.map((call) => call[0])).toEqual([0, 100]);
  });

  it("reports every tile when the clock moves past the interval", async () => {
    const source = gradient(600, 4);
    const store = storeWith(source);
    let now = 0;
    const onProgress = vi.fn();
    await renderRegion({
      binding: binding(invert),
      params: 0,
      store,
      region: rect(0, 0, 600, 4),
      original: source,
      backend: "cpu",
      signal: signal(),
      clock: () => (now += 1000),
      onProgress,
    });
    const percents = onProgress.mock.calls.map((call) => call[0]);
    expect(percents.slice(0, 2)).toEqual([0, 42]);
    expect(percents.at(-1)).toBe(100);
  });

  it("reports written tiles about once per frame, and always after the last one", async () => {
    const source = gradient(1024, 4);
    const store = storeWith(source);
    const seen: number[] = [];
    let now = 0;
    // Each tile write takes 10 ms.
    const write = store.writeRegion.bind(store);
    vi.spyOn(store, "writeRegion").mockImplementation((...args) => {
      now += 10;
      return write(...args);
    });
    await renderRegion({
      binding: binding(invert),
      params: 0,
      store,
      region: rect(0, 0, 1024, 4),
      original: source,
      backend: "cpu",
      signal: signal(),
      clock: () => now,
      // Each report sees the tiles written so far: the first pixel of the newest tile is inverted.
      onWrite: () => {
        const written = [0, 256, 512, 768].filter(
          (x) => store.readRegion(rect(x, 0, 1, 1)).data[0] !== source.data[x * 4],
        );
        seen.push(written.length);
      },
    });
    // Tiles land at 0, 10, 20 and 30 ms: the first is shown at once, the second waits for the
    // interval, the third is shown with it, and the last is shown when the render ends.
    expect(seen).toEqual([1, 3, 4]);
  });

  it("reports the restored original when a render fails or is canceled", async () => {
    const source = gradient(300, 4);
    const store = storeWith(source);
    const controller = new AbortController();
    const onWrite = vi.fn();
    await renderRegion({
      binding: binding(invert),
      params: 0,
      store,
      region: rect(0, 0, 300, 4),
      original: source,
      backend: "cpu",
      signal: controller.signal,
      clock: ticking(),
      yieldToHost: async () => controller.abort(),
      onWrite,
    });
    // The first tile, then the restore.
    expect(onWrite).toHaveBeenCalledTimes(2);
    expect([...store.readRegion(rect(0, 0, 300, 4)).data]).toEqual([...source.data]);
  });

  it("keeps the written tiles of a canceled live preview when asked to", async () => {
    const source = gradient(300, 4);
    const store = storeWith(source);
    const controller = new AbortController();
    const outcome = await renderRegion({
      binding: binding(invert),
      params: 0,
      store,
      region: rect(0, 0, 300, 4),
      original: source,
      backend: "cpu",
      signal: controller.signal,
      restoreOnCancel: false,
      clock: ticking(),
      yieldToHost: async () => controller.abort(),
    });
    expect(outcome).toBe("canceled");
    expect(store.readRegion(rect(0, 0, 1, 1)).data[0]).toBe(255 - (source.data[0] ?? 0));
    expect(store.readRegion(rect(256, 0, 1, 1)).data[0]).toBe(source.getPixel(256, 0).r);
  });

  it("writes tiles for a slice of time between yields, not one tile per yield (L10)", async () => {
    const source = gradient(2048, 4);
    const store = storeWith(source);
    let now = 0;
    const write = store.writeRegion.bind(store);
    vi.spyOn(store, "writeRegion").mockImplementation((...args) => {
      now += 3;
      return write(...args);
    });
    const yields = vi.fn(async () => {});
    await renderRegion({
      binding: binding(invert),
      params: 0,
      store,
      region: rect(0, 0, 2048, 4),
      original: source,
      backend: "cpu",
      signal: signal(),
      clock: () => now,
      yieldToHost: yields,
    });
    // 8 tiles of 3 ms in slices of WRITE_SLICE_MS (8 ms): a yield after every third tile.
    expect(yields).toHaveBeenCalledTimes(2);
    expect(store.readRegion(rect(2047, 0, 1, 1)).data[0]).toBe(255 - (source.data[2047 * 4] ?? 0));
  });

  it("does nothing for an empty region", async () => {
    const source = gradient(4, 4);
    const store = storeWith(source);
    const outcome = await renderRegion({
      binding: binding(invert),
      params: 0,
      store,
      region: rect(0, 0, 0, 0),
      original: source,
      backend: "cpu",
      signal: signal(),
    });
    expect(outcome).toBe("done");
  });
});
