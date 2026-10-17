/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { rgba8, TiledPixelStore } from "@openpaint/document";
import { beforeAll, describe, expect, it } from "vitest";
import type { CompositeDocument } from "./composite";
import { initCpu } from "./cpu";
import { DisplayTileBuilder, DisplayTileCache } from "./display-tiles";
import { Engine, REFINE_DELAY_MS } from "./engine";
import { FakeAdapter, type FakeDevice, FakeGpu } from "./fake-gpu";
import { FLOAT_DISPLAY_SHADERS } from "./float-display";
import type { FramePlan } from "./frame";
import type { Presenter } from "./presenter";
import type { EngineStatus } from "./protocol";
import type { ViewLayout } from "./view";

/**
 * How a GPU presenter's `present` fails: `throw` (configure or `getCurrentTexture` refused),
 * `reject` (a validation error the GPU reports later), or not at all.
 */
type PresentFault = "throw" | "reject" | undefined;

class FakePresenter implements Presenter {
  readonly calls: string[] = [];
  readonly plans: FramePlan[] = [];
  constructor(
    readonly device: GPUDevice | undefined,
    readonly fault: (present: number) => PresentFault = () => undefined,
  ) {}
  resize(width: number, height: number): void {
    this.calls.push(`resize ${width}x${height}`);
  }
  present(plan: FramePlan): void | Promise<void> {
    this.calls.push("present");
    this.plans.push(plan);
    const fault = this.fault(this.plans.length);
    if (fault === "throw") throw new Error("Canvas not configured");
    if (fault === "reject") return Promise.reject(new Error("validation error"));
    return this.device ? Promise.resolve() : undefined;
  }
  trim(): void {
    this.calls.push("trim");
  }
}

/** `step` advances the fake clock on every read, to model slow tile builds. */
function setup(
  adapter: FakeAdapter | null = new FakeAdapter(),
  step = 0,
  presented?: (start: number, end: number) => void,
  faults: {
    /** How the GPU presenter's nth present (1-based) fails. */
    present?: (present: number) => PresentFault;
    /** The GPU presenter cannot be created. */
    create?: boolean;
  } = {},
) {
  const gpu = new FakeGpu(() => adapter);
  const presenters: FakePresenter[] = [];
  const errors: unknown[] = [];
  const emitted: ((status: EngineStatus) => void)[] = [];
  const layouts: ViewLayout[] = [];
  const frames: (() => void)[] = [];
  let time = 0;
  const engine = new Engine(
    {
      gpu: gpu.gpu,
      now: () => {
        const t = time;
        time += step;
        return t;
      },
      benchmark: async () => "Good",
      createPresenter: (device) => {
        if (device && faults.create) throw new Error("WebGPU canvas context is unavailable.");
        const presenter = new FakePresenter(device, device ? faults.present : undefined);
        presenters.push(presenter);
        return presenter;
      },
      emitStatus: (status) => emitted.shift()?.(status),
      reportError: (error) => errors.push(error),
      emitView: (layout) => layouts.push(layout),
      requestFrame: (callback) => frames.push(callback),
      ...(presented && { presented }),
    },
    {
      backend: "Automatic",
      errorFlags: 0,
      performanceCache: {},
      width: 800,
      height: 600,
      scale: 1,
    },
  );
  return {
    engine,
    gpu,
    presenters,
    errors,
    layouts,
    /** Resolves with the next status the engine reports on its own. */
    nextStatus(): Promise<EngineStatus> {
      return new Promise<EngineStatus>((resolve) => emitted.push(resolve));
    },
    setTime: (t: number) => {
      time = t;
    },
    /** Runs queued tile-build slices until no more are requested. */
    flush(): void {
      for (let i = 0; i < 100 && frames.length > 0; i++) {
        for (const callback of frames.splice(0)) callback();
      }
    },
    /** Loses `device` and resolves with the status the engine reports afterwards. */
    lose(device: FakeDevice | undefined): Promise<EngineStatus> {
      const next = new Promise<EngineStatus>((resolve) => emitted.push(resolve));
      device?.lose();
      return next;
    },
  };
}

function documentOf(store: TiledPixelStore): CompositeDocument {
  return {
    width: store.width,
    height: store.height,
    layers: [{ store, mode: 0, opacity: 255, visible: true }],
  };
}

describe("Engine", () => {
  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
  });

  it("starts on WebGPU, presents at the canvas size and caches the performance class", async () => {
    const adapter = new FakeAdapter();
    const { engine, presenters } = setup(adapter);
    const status = await engine.start();
    expect(status).toMatchObject({
      setting: "Automatic",
      backend: "webgpu",
      reason: "chosen",
      performanceClass: "Good",
      errorFlags: 0,
      deviceLossCount: 0,
      performanceCache: { "acme|rdna||Acme(R) Graphics(TM)": "Good" },
    });
    expect(presenters[0]?.device).toBe(adapter.devices[0]);
    expect(presenters[0]?.calls).toEqual(["resize 800x600", "present"]);

    engine.resize({ width: 1024, height: 768, scale: 1 });
    expect(presenters[0]?.calls.slice(2)).toEqual(["resize 1024x768", "present"]);
  });

  it("trims presenter resources while hidden and presents again when visible (ARC-03-10)", async () => {
    const { engine, presenters } = setup();
    await engine.start();
    engine.setVisible(false);
    expect(presenters[0]?.calls.at(-1)).toBe("trim");
    engine.setVisible(true);
    expect(presenters[0]?.calls.slice(-2)).toEqual(["trim", "present"]);
  });

  it("starts on the CPU backend without WebGPU", async () => {
    const { engine, presenters } = setup(null);
    expect(await engine.start()).toMatchObject({ backend: "cpu", reason: "unavailable" });
    expect(presenters[0]?.device).toBeUndefined();
    expect(presenters[0]?.calls).toEqual(["resize 800x600", "present"]);
  });

  it("presents again on a new device after a loss", async () => {
    const adapter = new FakeAdapter();
    const { engine, presenters, lose } = setup(adapter);
    await engine.start();
    const [first] = adapter.devices;

    const status = await lose(first);
    expect(status).toMatchObject({ backend: "webgpu", reason: "chosen", deviceLossCount: 1 });
    const second = adapter.devices[1];
    expect(presenters[1]?.device).toBe(second);
    expect(presenters[1]?.calls).toEqual(["resize 800x600", "present"]);
  });

  it("falls back to CPU after three losses within 60 s and leaves the setting alone", async () => {
    const adapter = new FakeAdapter();
    const { engine, presenters, lose, setTime } = setup(adapter);
    await engine.start();
    await lose(adapter.devices[0]);
    setTime(30_000);
    await lose(adapter.devices[1]);
    setTime(59_000);
    const status = await lose(adapter.devices[2]);
    expect(status).toMatchObject({
      setting: "Automatic",
      backend: "cpu",
      reason: "device-loss",
      errorFlags: 1,
      deviceLossCount: 3,
    });
    expect(adapter.devices).toHaveLength(3);
    expect(presenters.at(-1)?.device).toBeUndefined();

    expect(await engine.setBackend("Automatic")).toMatchObject({
      backend: "webgpu",
      errorFlags: 0,
      deviceLossCount: 3,
    });
  });

  it("keeps recovering when losses are more than 60 s apart", async () => {
    const adapter = new FakeAdapter();
    const { engine, lose, setTime } = setup(adapter);
    await engine.start();
    for (let i = 0; i < 4; i++) {
      setTime(i * 31_000);
      expect(await lose(adapter.devices[i])).toMatchObject({ backend: "webgpu" });
    }
  });

  it("builds the visible display tiles and presents them", async () => {
    const { engine, presenters, flush } = setup();
    await engine.start();
    const store = new TiledPixelStore(300, 200);
    engine.setDocument(documentOf(store));
    flush();
    const plan = presenters[0]?.plans.at(-1);
    expect(plan?.wanted).toEqual([]);
    // Fit zoom: 300 x 200 scales to 800 x 533 device pixels, covering the 3 x 2 level-0 tiles.
    expect(plan?.zoom).toBeCloseTo(800 / 300);
    expect(plan?.tiles.map((t) => [t.tile.tx, t.tile.ty])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ]);
  });

  it("rebuilds the tiles under a small edit before presenting, so no frame lacks them", async () => {
    const { engine, presenters, flush } = setup();
    await engine.start();
    const store = new TiledPixelStore(300, 200);
    engine.setDocument(documentOf(store));
    flush();

    store.setPixel(10, 10, rgba8(255, 0, 0, 255));
    engine.render();
    const plan = presenters.at(-1)?.plans.at(-1);
    expect(plan?.wanted).toEqual([]);
    expect(plan?.tiles).toHaveLength(6);
    const tile = plan?.tiles[0]?.tile;
    expect(tile?.pixels.slice((10 * 128 + 10) * 4, (10 * 128 + 10) * 4 + 4)).toEqual(
      new Uint8Array([255, 0, 0, 255]),
    );
    expect(store.dirtyTileCount).toBe(0);
  });

  it("reports every present to the perf hook and is idle once its tiles are built", async () => {
    const presents: [number, number][] = [];
    // Every clock read advances 10 ms, so tiles are built in later slices, not before the present.
    const { engine, presenters, flush } = setup(new FakeAdapter(), 10, (start, end) =>
      presents.push([start, end]),
    );
    await engine.start();
    expect(presents).toHaveLength(1);
    engine.setDocument(documentOf(new TiledPixelStore(300, 200)));
    expect(engine.idle).toBe(false);
    flush();
    expect(engine.idle).toBe(true);
    expect(presents).toHaveLength(presenters[0]?.plans.length ?? 0);
    for (const [start, end] of presents) expect(end).toBeGreaterThan(start);
  });

  it("compiles the float display's pipelines in the background once it is first idle", async () => {
    const adapter = new FakeAdapter();
    const { engine, flush } = setup(adapter, 10);
    await engine.start();
    engine.setDocument(documentOf(new TiledPixelStore(300, 200)));
    const device = adapter.devices[0] as FakeDevice;
    const warmed = () => device.pipelines.filter((pipeline) => pipeline.async);
    expect(warmed()).toEqual([]);
    flush();
    expect(engine.idle).toBe(true);
    expect(warmed().map((pipeline) => pipeline.label)).toEqual(
      FLOAT_DISPLAY_SHADERS.map((shader) => shader.label),
    );
    engine.setDocument(documentOf(new TiledPixelStore(310, 200)));
    flush();
    expect(warmed()).toHaveLength(FLOAT_DISPLAY_SHADERS.length);
    expect(device.pipelines.some((pipeline) => !pipeline.async)).toBe(false);
  });

  it("keeps showing stale tiles under an edit until they are rebuilt, never leaving gaps", async () => {
    // Every clock read advances 10 ms, so the 6 ms present budget builds nothing.
    const { engine, presenters, flush } = setup(new FakeAdapter(), 10);
    await engine.start();
    const store = new TiledPixelStore(300, 200);
    engine.setDocument(documentOf(store));
    flush();
    const before = presenters
      .at(-1)
      ?.plans.at(-1)
      ?.tiles.map((t) => t.tile);
    expect(before).toHaveLength(6);

    // The edit sits in store tile (0, 0), which covers document x 0-255: display tiles 0-1 in x.
    store.setPixel(10, 10, rgba8(255, 0, 0, 255));
    const firstAfterEdit = presenters.at(-1)?.plans.length ?? 0;
    engine.render();
    const plan = presenters.at(-1)?.plans.at(-1);
    expect(plan?.tiles.map((t) => t.tile)).toEqual(before);
    expect(plan?.wanted).toEqual([
      { level: 0, tx: 0, ty: 0 },
      { level: 0, tx: 1, ty: 0 },
      { level: 0, tx: 0, ty: 1 },
      { level: 0, tx: 1, ty: 1 },
    ]);

    flush();
    const plans = presenters.at(-1)?.plans.slice(firstAfterEdit) ?? [];
    expect(plans.length).toBeGreaterThan(1);
    expect(plans.every((p) => p.tiles.length === 6)).toBe(true);
    const tile = plans.at(-1)?.tiles[0]?.tile;
    expect(tile?.pixels.slice((10 * 128 + 10) * 4, (10 * 128 + 10) * 4 + 4)).toEqual(
      new Uint8Array([255, 0, 0, 255]),
    );
    expect(plans.at(-1)?.wanted).toEqual([]);
  });

  it("keeps showing the old tiles after a restack until they are rebuilt (L4)", async () => {
    const { engine, presenters, flush } = setup(new FakeAdapter(), 10);
    await engine.start();
    const store = new TiledPixelStore(300, 200);
    store.fill(rgba8(255, 0, 0, 255));
    engine.setDocument(documentOf(store));
    flush();
    const before = presenters
      .at(-1)
      ?.plans.at(-1)
      ?.tiles.map((t) => t.tile);
    expect(before).toHaveLength(6);

    engine.restack({
      ...documentOf(store),
      layers: [{ store, mode: 0, opacity: 255, visible: false }],
    });
    const plan = presenters.at(-1)?.plans.at(-1);
    expect(plan?.tiles.map((t) => t.tile)).toEqual(before);
    expect(plan?.wanted).toHaveLength(6);

    flush();
    const last = presenters.at(-1)?.plans.at(-1);
    expect(last?.wanted).toEqual([]);
    expect(last?.tiles).toHaveLength(6);
    expect(last?.tiles[0]?.tile.pixels.slice(0, 4)).toEqual(new Uint8Array([0, 0, 0, 0]));
  });

  it("shows draft mip tiles first and refines them once edits pause (ARC-03-04)", async () => {
    const { engine, presenters, flush, setTime } = setup();
    await engine.start();
    // Fit zoom 0.4: level 1.
    const store = new TiledPixelStore(2000, 1000);
    store.fill(rgba8(10, 200, 30, 255));
    setTime(1000);
    engine.setDocument(documentOf(store));
    flush();
    const drawn = () => presenters.at(-1)?.plans.at(-1)?.tiles ?? [];
    expect(drawn().length).toBeGreaterThan(0);
    expect(drawn().every((t) => t.tile.level === 1)).toBe(true);
    expect(engine.idle).toBe(false);

    setTime(1000 + REFINE_DELAY_MS);
    flush();
    expect(engine.idle).toBe(true);
    expect(presenters.at(-1)?.plans.at(-1)?.wanted).toEqual([]);
    const reference = new DisplayTileCache();
    const builder = new DisplayTileBuilder(reference, () => documentOf(store));
    const first = drawn()[0]?.tile;
    if (first === undefined) throw new Error("nothing drawn");
    builder.request([first]);
    builder.pump(Number.POSITIVE_INFINITY, () => 0);
    builder.request([first], [first]);
    builder.pump(Number.POSITIVE_INFINITY, () => 0);
    expect(first.pixels).toEqual(reference.get(first.level, first.tx, first.ty)?.pixels);
  });

  it("zooms with view commands and the wheel, reporting the view it leaves", async () => {
    const { engine, flush } = setup();
    await engine.start();
    engine.setDocument(documentOf(new TiledPixelStore(300, 200)));
    flush();

    expect(engine.view({ type: "actualSize" })).toEqual({ mode: "fixed", zoom: 1 });
    expect(engine.view({ type: "zoomIn" })).toEqual({ mode: "fixed", zoom: 3 / 2 });
    expect(engine.view({ type: "zoomOut" })).toEqual({ mode: "fixed", zoom: 1 });
    expect(engine.view({ type: "fit" })).toEqual({ mode: "fit", zoom: 800 / 300 });
    expect(
      engine.wheel({
        x: 400,
        y: 300,
        deltaX: 0,
        deltaY: -100,
        deltaMode: 0,
        ctrlKey: true,
        shiftKey: false,
      }),
    ).toEqual({ mode: "fixed", zoom: (800 / 300) * 1.12 });
  });

  it("reports the view layout only when it changes (UI-SB-01)", async () => {
    const { engine, layouts, flush } = setup();
    await engine.start();
    engine.setDocument(documentOf(new TiledPixelStore(300, 200)));
    flush();
    const fit = layouts.at(-1);
    expect(fit).toEqual({
      mode: "fit",
      zoom: 800 / 300,
      originX: 0,
      originY: Math.round((600 - 200 * (800 / 300)) / 2),
      documentWidth: 300,
      documentHeight: 200,
    });

    const count = layouts.length;
    engine.render();
    expect(layouts).toHaveLength(count);

    engine.view({ type: "zoom", ratio: 2 });
    expect(layouts.at(-1)).toMatchObject({ mode: "fixed", zoom: 2 });
    expect(layouts).toHaveLength(count + 1);
  });

  for (const fault of ["throw", "reject"] as const) {
    it(`falls back to CPU when every GPU present fails (${fault}), as after device loss`, async () => {
      const adapter = new FakeAdapter();
      const { engine, presenters, errors, nextStatus, flush } = setup(adapter, 0, undefined, {
        present: () => fault,
      });
      const fallback = nextStatus();
      await engine.start();
      // Each failure retries on the next frame until the third in a row abandons the GPU.
      for (let i = 0; i < 10 && presenters.length === 1; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        flush();
      }
      expect(await fallback).toMatchObject({
        setting: "Automatic",
        backend: "cpu",
        reason: "device-loss",
        errorFlags: 1,
      });
      expect(presenters[0]?.calls.filter((call) => call === "present")).toHaveLength(3);
      expect(adapter.devices[0]?.destroyed).toBe(true);
      expect(presenters[1]?.device).toBeUndefined();
      expect(presenters[1]?.calls).toEqual(["resize 800x600", "present"]);
      // The first failure is logged for the page; the repeats are not.
      expect(errors).toHaveLength(1);

      // Picking a backend again clears the fallback, like after device loss.
      expect(await engine.setBackend("Automatic")).toMatchObject({
        backend: "webgpu",
        errorFlags: 0,
      });
    });
  }

  it("keeps the GPU after a single failed present: the next frame presents again", async () => {
    const adapter = new FakeAdapter();
    const { engine, presenters, errors, flush } = setup(adapter, 0, undefined, {
      present: (n) => (n === 1 ? "reject" : undefined),
    });
    await engine.start();
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      flush();
    }
    expect(presenters).toHaveLength(1);
    expect(presenters[0]?.calls.filter((call) => call === "present")).toHaveLength(2);
    expect(engine.status).toMatchObject({ backend: "webgpu", errorFlags: 0 });
    expect(errors).toHaveLength(1);
  });

  it("does not count failures separated by a good present as persistent", async () => {
    const adapter = new FakeAdapter();
    const { engine, presenters, flush } = setup(adapter, 0, undefined, {
      present: (n) => (n % 2 === 1 ? "throw" : undefined),
    });
    await engine.start();
    for (let i = 0; i < 4; i++) {
      engine.render();
      await new Promise((resolve) => setTimeout(resolve, 0));
      flush();
    }
    expect(presenters).toHaveLength(1);
    expect(engine.status.backend).toBe("webgpu");
  });

  it("starts on the CPU backend when the GPU presenter cannot be created", async () => {
    const adapter = new FakeAdapter();
    const { engine, presenters, errors } = setup(adapter, 0, undefined, { create: true });
    expect(await engine.start()).toMatchObject({
      backend: "cpu",
      reason: "device-loss",
      errorFlags: 1,
    });
    expect(adapter.devices[0]?.destroyed).toBe(true);
    expect(presenters).toHaveLength(1);
    expect(presenters[0]?.device).toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it("switches backends without treating the released device as lost", async () => {
    const adapter = new FakeAdapter();
    const { engine, presenters } = setup(adapter);
    await engine.start();
    expect(await engine.setBackend("Cpu")).toMatchObject({
      setting: "Cpu",
      backend: "cpu",
      reason: "turned-off",
      deviceLossCount: 0,
    });
    expect(adapter.devices[0]?.destroyed).toBe(true);
    await Promise.resolve();
    expect(adapter.devices).toHaveLength(1);
    expect(presenters).toHaveLength(2);
    expect((await engine.setBackend("WebGPU")).backend).toBe("webgpu");
  });
});
