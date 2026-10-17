// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { rect, Selection, Surface, TiledPixelStore } from "@openpaint/document";
import { clipToCoverage } from "@openpaint/effects";
import { type GradientOptions, gradientCpu } from "@openpaint/engine";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type GradientLanes,
  GradientRenderer,
  type GradientTile,
  type GradientTileJob,
  type GradientTileReply,
  renderGradientTile,
  WHOLE_SESSION,
} from "./gradient-tiles";
import { LayerSnapshot } from "./layer-patch";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const OPTIONS: GradientOptions = {
  shape: "Radial",
  repeat: "RepeatReflected",
  start: { x: 100.5, y: 80.25 },
  end: { x: 310, y: 260 },
  startColor: { r: 250, g: 10, b: 40, a: 255 },
  endColor: { r: 0, g: 120, b: 255, a: 90 },
  alphaOnly: false,
  antialias: true,
  blend: 0,
  seed: 1234,
};

/** Lanes that answer only when told, the way workers answer later. */
class LaterLanes implements GradientLanes {
  readonly inline = false;
  readonly jobs: { lane: number; job: GradientTileJob }[] = [];
  readonly #listeners = new Map<number, (reply: GradientTileReply) => void>();
  readonly #cache = new Map<
    string,
    { base: Uint8ClampedArray<ArrayBuffer>; coverage?: Uint8Array }
  >();

  constructor(readonly count: number) {}

  post(lane: number, job: GradientTileJob): void {
    if (job.kind === "tile" && job.base !== undefined) {
      this.#cache.set(`${job.session}:${job.key}`, {
        base: job.base,
        ...(job.coverage && { coverage: job.coverage }),
      });
    }
    this.jobs.push({ lane, job });
  }

  listen(session: number, listener: (reply: GradientTileReply) => void): () => void {
    this.#listeners.set(session, listener);
    return () => this.#listeners.delete(session);
  }

  /** Answers the waiting jobs, oldest first, `count` of them or all. */
  answer(count = Number.POSITIVE_INFINITY): void {
    for (let i = 0; i < count; i++) {
      const next = this.jobs.findIndex(({ job }) => job.kind === "tile");
      if (next < 0) return;
      const job = this.jobs.splice(next, 1)[0]?.job;
      if (job?.kind !== "tile") continue;
      const tile = this.#cache.get(`${job.session}:${job.key}`);
      if (tile === undefined) throw new Error("no base");
      this.#listeners.get(job.session)?.({
        session: job.session,
        generation: job.generation,
        key: job.key,
        ok: true,
        pixels: renderGradientTile(job, tile.base, tile.coverage),
      });
    }
  }

  fail(session: number): void {
    this.#listeners.get(session)?.({
      session,
      generation: 0,
      key: WHOLE_SESSION,
      ok: false,
      message: "stopped",
    });
  }
}

function noise(width: number, height: number): TiledPixelStore {
  const data = new Uint8ClampedArray(width * height * 4);
  let state = 7;
  for (let i = 0; i < data.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    data[i] = state >>> 24;
  }
  const store = new TiledPixelStore(width, height);
  store.writeRegion(new Surface(width, height, data), 0, 0);
  return store;
}

function setup(lanes: GradientLanes, selection?: Selection) {
  const store = noise(600, 300);
  const before = store.readRegion(store.bounds);
  const area = selection === undefined ? store.bounds : rect(40, 30, 500, 200);
  const coverage = selection?.mask(area);
  const writes: GradientTile[][] = [];
  const renderer = new GradientRenderer({
    lanes,
    base: new LayerSnapshot(store),
    store,
    area,
    coverage,
    write: (tiles) => {
      writes.push([...tiles]);
      for (const tile of tiles) store.writeRegion(tile.output, tile.area.x, tile.area.y);
    },
  });
  return { store, before, area, coverage, renderer, writes };
}

describe("GradientRenderer (L7)", () => {
  it("renders tile by tile in lanes to exactly the whole-layer render", async () => {
    const lanes = new LaterLanes(3);
    const { store, before, renderer } = setup(lanes);
    const generation = renderer.render(OPTIONS);
    expect(renderer.isComplete(generation)).toBe(false);
    // One job per lane at a time.
    expect(lanes.jobs).toHaveLength(3);
    const done = renderer.whenComplete(generation);
    while (lanes.jobs.length > 0) lanes.answer(1);
    await done;
    expect(renderer.isComplete(generation)).toBe(true);
    expect(
      firstDifference(store.readRegion(store.bounds).data, gradientCpu(before, OPTIONS).data),
    ).toBe(-1);
  });

  it("clips to the selection over its bounds", () => {
    const lanes = new LaterLanes(2);
    const selection = new Selection([[60.5, 40, 520, 50, 300, 220.25]]);
    const { store, before, area, coverage, renderer } = setup(lanes, selection);
    renderer.render(OPTIONS);
    while (lanes.jobs.length > 0) lanes.answer();
    const original = cropOf(before, area);
    const expected = clipToCoverage(
      original,
      gradientCpu(original, { ...OPTIONS, origin: { x: area.x, y: area.y } }),
      coverage ?? new Uint8Array(),
    );
    expect(firstDifference(store.readRegion(area).data, expected.data)).toBe(-1);
    // Outside the bounds nothing changed.
    expect(store.readRegion(rect(0, 0, 40, 300))).toEqual(cropOf(before, rect(0, 0, 40, 300)));
  });

  it("drops an older generation's tiles and sends each tile's base once", () => {
    const lanes = new LaterLanes(1);
    const { store, before, renderer, writes } = setup(lanes);
    const first = renderer.render(OPTIONS);
    const second = renderer.render({ ...OPTIONS, end: { x: 20, y: 20 } });
    expect(renderer.isLive(first)).toBe(false);
    // The job in flight belongs to the first generation; its answer is dropped.
    lanes.answer(1);
    expect(writes).toHaveLength(0);
    while (lanes.jobs.length > 0) lanes.answer(1);
    expect(renderer.isComplete(second)).toBe(true);
    const withBase = lanes.jobs.length;
    expect(withBase).toBe(0);
    expect(
      firstDifference(
        store.readRegion(store.bounds).data,
        gradientCpu(before, { ...OPTIONS, end: { x: 20, y: 20 } }).data,
      ),
    ).toBe(-1);
    renderer.render(OPTIONS);
    const job = lanes.jobs[0]?.job;
    expect(job?.kind === "tile" && job.base === undefined).toBe(true);
  });

  it("starts with the tiles nearest the priority area", () => {
    const lanes = new LaterLanes(1);
    const { renderer } = setup(lanes);
    renderer.render(OPTIONS, rect(520, 250, 10, 10));
    const job = lanes.jobs[0]?.job;
    expect(job?.kind === "tile" ? [job.x, job.y] : undefined).toEqual([512, 256]);
  });

  it("rejects a wait when the generation is replaced, canceled or its worker stops", async () => {
    const lanes = new LaterLanes(1);
    const { renderer } = setup(lanes);
    const replaced = renderer.whenComplete(renderer.render(OPTIONS));
    renderer.render({ ...OPTIONS, seed: 1 });
    await expect(replaced).rejects.toThrow(/replaced/);
    const stopped = renderer.whenComplete(renderer.generation);
    lanes.fail(lanes.jobs.find(({ job }) => job.kind === "tile")?.job.session ?? 0);
    await expect(stopped).rejects.toThrow("stopped");
  });
});

function cropOf(surface: Surface, area: { x: number; y: number; width: number; height: number }) {
  const out = new Surface(area.width, area.height);
  out.copyFrom(surface, area, 0, 0);
  return out;
}

/** The first index where two byte arrays differ, or -1; far faster than a deep equal on images. */
function firstDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}
