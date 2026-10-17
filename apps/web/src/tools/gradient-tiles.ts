import {
  intersectRects,
  isEmptyRect,
  type Rect,
  rect,
  Surface,
  TILE_SIZE,
  type TiledPixelStore,
} from "@openpaint/document";
import { clipToCoverage } from "@openpaint/effects";
import { type GradientOptions, gradientCpu } from "@openpaint/engine";
import type { LayerSnapshot } from "./layer-patch";

/**
 * Gradient renders split into store tiles and run in workers (L7). Every tile renders at its own
 * canvas origin, so its pixels, dither included, equal the same pixels of a whole-layer render
 * (TL-ALG-GRAD): the result is the Rust reference whichever worker renders which tile.
 */

/** One tile of a gradient render, as it goes to a worker. */
export type GradientTileJob =
  | {
      readonly kind: "tile";
      readonly session: number;
      readonly generation: number;
      /** The store tile, `ty * tilesX + tx`. */
      readonly key: number;
      /** The part of the tile rendered, in canvas pixels. */
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly options: GradientOptions;
      /** The tile's pixels before the gradient. Sent the first time a worker gets the tile. */
      readonly base?: Uint8ClampedArray<ArrayBuffer>;
      /** The selection coverage over the part, sent with `base`; none renders it unclipped. */
      readonly coverage?: Uint8Array;
    }
  /** Ends a session: the workers drop what they keep for it. */
  | { readonly kind: "end"; readonly session: number };

export type GradientTileReply =
  | {
      readonly session: number;
      readonly generation: number;
      readonly key: number;
      readonly ok: true;
      readonly pixels: Uint8ClampedArray<ArrayBuffer>;
    }
  | {
      readonly session: number;
      readonly generation: number;
      readonly key: number;
      readonly ok: false;
      readonly message: string;
    };

/** Renders one tile: the gradient over `base` at the tile's origin, clipped by `coverage`. */
export function renderGradientTile(
  job: Extract<GradientTileJob, { kind: "tile" }>,
  base: Uint8ClampedArray<ArrayBuffer>,
  coverage: Uint8Array | undefined,
): Uint8ClampedArray<ArrayBuffer> {
  const input = new Surface(job.width, job.height, base);
  const filled = gradientCpu(input, { ...job.options, origin: { x: job.x, y: job.y } });
  const output = coverage === undefined ? filled : clipToCoverage(input, filled, coverage);
  const data = output.data as Uint8ClampedArray<ArrayBuffer>;
  return data.buffer === base.buffer ? data.slice() : data;
}

/** Where gradient tiles run: workers, or this thread when there are none. */
export interface GradientLanes {
  /** How many tiles can run at once. */
  readonly count: number;
  /** True when a job runs on this thread, answering before `post` returns. */
  readonly inline: boolean;
  /** Runs a job on one lane. Its reply goes to the listener of its session. */
  post(lane: number, job: GradientTileJob, transfer: Transferable[]): void;
  /** Receives the replies of one session. Returns the function that stops it. */
  listen(session: number, listener: (reply: GradientTileReply) => void): () => void;
}

/** The failure of a tile job whose base pixels never reached its lane (a bug, not user text). */
const NO_BASE = "The tile's base pixels were never sent.";

/** Runs every tile on this thread, at once: tests and browsers without workers. */
export class InlineGradientLanes implements GradientLanes {
  readonly count = 1;
  readonly inline = true;
  readonly #listeners = new Map<number, (reply: GradientTileReply) => void>();
  readonly #cache = new Map<
    string,
    { base: Uint8ClampedArray<ArrayBuffer>; coverage?: Uint8Array }
  >();

  post(_lane: number, job: GradientTileJob): void {
    if (job.kind === "end") {
      for (const key of [...this.#cache.keys()]) {
        if (key.startsWith(`${job.session}:`)) this.#cache.delete(key);
      }
      return;
    }
    const key = `${job.session}:${job.key}`;
    if (job.base !== undefined) {
      this.#cache.set(key, { base: job.base, ...(job.coverage && { coverage: job.coverage }) });
    }
    const tile = this.#cache.get(key);
    const listener = this.#listeners.get(job.session);
    if (tile === undefined) {
      listener?.({ ...job, ok: false, message: NO_BASE });
      return;
    }
    const pixels = renderGradientTile(job, tile.base, tile.coverage);
    listener?.({
      session: job.session,
      generation: job.generation,
      key: job.key,
      ok: true,
      pixels,
    });
  }

  listen(session: number, listener: (reply: GradientTileReply) => void): () => void {
    this.#listeners.set(session, listener);
    return () => this.#listeners.delete(session);
  }
}

/** The part of a `Worker` the pool uses, so a test can stand in for one. */
export interface GradientWorkerLike {
  postMessage(message: GradientTileJob, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<GradientTileReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}

/** The key of a reply that fails a whole session, such as a worker that stopped. */
export const WHOLE_SESSION = -1;

/** Gradient tiles in a few workers, started on first use and kept for the page's life. */
export class WorkerGradientLanes implements GradientLanes {
  readonly count: number;
  readonly inline = false;
  readonly #create: () => GradientWorkerLike;
  readonly #workers: (GradientWorkerLike | undefined)[];
  readonly #listeners = new Map<number, (reply: GradientTileReply) => void>();

  constructor(count: number, create: () => GradientWorkerLike) {
    this.count = Math.max(1, count);
    this.#create = create;
    this.#workers = Array.from({ length: this.count }, () => undefined);
  }

  post(lane: number, job: GradientTileJob, transfer: Transferable[]): void {
    let worker = this.#workers[lane];
    if (worker === undefined) {
      if (job.kind === "end") return;
      const created = this.#create();
      created.onmessage = (event) => this.#listeners.get(event.data.session)?.(event.data);
      // A worker that stops fails every session, so no render waits for it forever. The next
      // job starts a new one.
      created.onerror = (event) => {
        created.terminate();
        if (this.#workers[lane] === created) this.#workers[lane] = undefined;
        for (const [session, listener] of [...this.#listeners]) {
          listener({
            session,
            generation: 0,
            key: WHOLE_SESSION,
            ok: false,
            message: event.message || "The gradient worker stopped.",
          });
        }
      };
      worker = created;
      this.#workers[lane] = worker;
    }
    worker.postMessage(job, transfer);
  }

  listen(session: number, listener: (reply: GradientTileReply) => void): () => void {
    this.#listeners.set(session, listener);
    return () => this.#listeners.delete(session);
  }
}

/** A rendered tile part, ready to be written into the layer. */
export interface GradientTile {
  readonly area: Rect;
  readonly output: Surface;
}

/**
 * Landed tiles written per frame. A 256 px tile is 256 KB, so this is about 12 MB of copying, a few
 * milliseconds (L10: the slice is sized by work, not one tile per frame).
 */
const TILES_PER_FRAME = 48;

let nextSession = 1;

interface TilePart {
  readonly key: number;
  readonly area: Rect;
  readonly lane: number;
  /** Whether its lane has the base pixels already. */
  sent: boolean;
  /** The generation the layer shows for it, 0 before the first write. */
  written: number;
}

/**
 * Renders a gradient over an area of a layer, tile by tile in `lanes`, as one generation per set
 * of options (L7). A new generation drops the work of older ones that has not started, and
 * replies from older generations are discarded, so the layer only ever shows tiles of the newest
 * generation as they land; tiles not yet re-rendered keep their last pixels (L4). The tiles nearest
 * the priority rectangle (the visible part) go first. Landed tiles are written at most once per
 * frame, a few milliseconds at a time.
 */
export class GradientRenderer {
  readonly #lanes: GradientLanes;
  readonly #base: LayerSnapshot;
  readonly #coverage: Uint8Array | undefined;
  readonly #area: Rect;
  readonly #write: (tiles: readonly GradientTile[]) => void;
  readonly #schedule: ((callback: () => void) => () => void) | undefined;
  readonly #session = nextSession++;
  readonly #parts: TilePart[] = [];
  readonly #byKey = new Map<number, TilePart>();
  readonly #stop: () => void;
  #generation = 0;
  #options: GradientOptions | undefined;
  /** Per lane, the tile parts of the newest generation still to send, next first. */
  #queues: TilePart[][];
  readonly #busy: boolean[];
  #ready: { part: TilePart; pixels: Uint8ClampedArray<ArrayBuffer> }[] = [];
  #cancelFrame: (() => void) | undefined;
  #waiters: { generation: number; resolve: () => void; reject: (error: Error) => void }[] = [];
  #failure: Error | undefined;

  /**
   * `area` is what the gradient covers: the layer, or the selection's bounds, with `coverage` over
   * it. `write` must write the tiles it gets into the layer at once.
   */
  constructor(options: {
    readonly lanes: GradientLanes;
    readonly base: LayerSnapshot;
    readonly store: TiledPixelStore;
    readonly area: Rect;
    readonly coverage: Uint8Array | undefined;
    readonly write: (tiles: readonly GradientTile[]) => void;
    readonly scheduleFrame?: (callback: () => void) => () => void;
  }) {
    this.#lanes = options.lanes;
    this.#base = options.base;
    this.#coverage = options.coverage;
    this.#area = options.area;
    this.#write = options.write;
    this.#schedule = options.scheduleFrame;
    const { store, area } = options;
    for (const { tx, ty } of store.tilesInRect(area)) {
      const part = intersectRects(area, rect(tx * TILE_SIZE, ty * TILE_SIZE, TILE_SIZE, TILE_SIZE));
      if (isEmptyRect(part)) continue;
      const key = ty * store.tilesX + tx;
      const tile = { key, area: part, lane: key % this.#lanes.count, sent: false, written: 0 };
      this.#parts.push(tile);
      this.#byKey.set(key, tile);
    }
    this.#queues = Array.from({ length: this.#lanes.count }, () => []);
    this.#busy = Array.from({ length: this.#lanes.count }, () => false);
    this.#stop = this.#lanes.listen(this.#session, (reply) => this.#reply(reply));
  }

  /** The newest generation. */
  get generation(): number {
    return this.#generation;
  }

  /** Starts rendering `options` as a new generation, tiles nearest `priority` first. */
  render(options: GradientOptions, priority?: Rect): number {
    this.#generation += 1;
    this.#options = options;
    this.#ready = [];
    this.#dropWaiters();
    const cx = priority === undefined ? 0 : priority.x + priority.width / 2;
    const cy = priority === undefined ? 0 : priority.y + priority.height / 2;
    const distance = (part: TilePart) =>
      priority === undefined
        ? 0
        : (part.area.x + part.area.width / 2 - cx) ** 2 +
          (part.area.y + part.area.height / 2 - cy) ** 2;
    const ordered = [...this.#parts].sort((a, b) => distance(a) - distance(b));
    this.#queues = Array.from({ length: this.#lanes.count }, () => []);
    for (const part of ordered) this.#queues[part.lane]?.push(part);
    this.#pump();
    return this.#generation;
  }

  /** Stops the newest generation: what has not landed is dropped. */
  cancel(): void {
    this.#generation += 1;
    this.#options = undefined;
    this.#dropWaiters();
    this.#queues = Array.from({ length: this.#lanes.count }, () => []);
    this.#ready = [];
    this.#cancelFrame?.();
    this.#cancelFrame = undefined;
  }

  /** Whether `generation` is the newest and was not canceled, so it renders or has rendered. */
  isLive(generation: number): boolean {
    return generation === this.#generation && this.#options !== undefined;
  }

  /** Whether every tile of `generation` has been written into the layer. */
  isComplete(generation: number): boolean {
    return (
      generation === this.#generation &&
      this.#options !== undefined &&
      this.#parts.every((part) => part.written === generation)
    );
  }

  /** Settles once every tile of `generation` is written; rejects if it is replaced or fails. */
  whenComplete(generation: number): Promise<void> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (this.isComplete(generation)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.#waiters.push({ generation, resolve, reject });
    });
  }

  /** Writes every landed tile now, rather than at the next frame. */
  flush(): void {
    this.#cancelFrame?.();
    this.#cancelFrame = undefined;
    this.#writeReady(Number.POSITIVE_INFINITY);
  }

  dispose(): void {
    this.cancel();
    this.#stop();
    for (let lane = 0; lane < this.#lanes.count; lane++) {
      this.#lanes.post(lane, { kind: "end", session: this.#session }, []);
    }
    for (const waiter of this.#waiters) waiter.reject(new Error("The gradient was discarded."));
    this.#waiters = [];
  }

  /** Fails the session: its waiters reject, and so does every later wait. */
  #fail(error: Error): void {
    this.#failure = error;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  /** Rejects the waiters of generations that can no longer complete. */
  #dropWaiters(): void {
    const stale = this.#waiters.filter((waiter) => waiter.generation !== this.#generation);
    this.#waiters = this.#waiters.filter((waiter) => waiter.generation === this.#generation);
    for (const waiter of stale) waiter.reject(new Error("The gradient render was replaced."));
  }

  #pump(): void {
    const options = this.#options;
    if (options === undefined) return;
    for (let lane = 0; lane < this.#lanes.count; lane++) {
      while (!this.#busy[lane]) {
        const part = this.#queues[lane]?.shift();
        if (part === undefined) break;
        this.#busy[lane] = true;
        const { x, y, width, height } = part.area;
        const job = {
          kind: "tile" as const,
          session: this.#session,
          generation: this.#generation,
          key: part.key,
          x,
          y,
          width,
          height,
          options,
        };
        if (part.sent) {
          this.#lanes.post(lane, job, []);
          continue;
        }
        part.sent = true;
        const base = this.#base.read(part.area).data as Uint8ClampedArray<ArrayBuffer>;
        const coverage = this.#coverageOf(part.area);
        const transfer: Transferable[] = [base.buffer];
        if (coverage !== undefined) transfer.push(coverage.buffer as ArrayBuffer);
        this.#lanes.post(lane, { ...job, base, ...(coverage && { coverage }) }, transfer);
      }
    }
  }

  /** The selection coverage over a tile part, cut out of the coverage over the whole area. */
  #coverageOf(part: Rect): Uint8Array | undefined {
    const coverage = this.#coverage;
    if (coverage === undefined) return undefined;
    const out = new Uint8Array(part.width * part.height);
    for (let y = 0; y < part.height; y++) {
      const from = (part.y - this.#area.y + y) * this.#area.width + part.x - this.#area.x;
      out.set(coverage.subarray(from, from + part.width), y * part.width);
    }
    return out;
  }

  #reply(reply: GradientTileReply): void {
    if (!reply.ok && reply.key === WHOLE_SESSION) {
      this.#busy.fill(false);
      // A new worker has none of the base pixels.
      for (const part of this.#parts) part.sent = false;
      this.#fail(new Error(reply.message));
      return;
    }
    const part = this.#byKey.get(reply.key);
    if (part === undefined) return;
    this.#busy[part.lane] = false;
    if (!reply.ok) {
      this.#fail(new Error(reply.message));
      return;
    }
    if (reply.generation === this.#generation) {
      this.#ready.push({ part, pixels: reply.pixels });
      if (this.#lanes.inline || this.#schedule === undefined) {
        this.#writeReady(Number.POSITIVE_INFINITY);
      } else {
        this.#cancelFrame ??= this.#schedule(() => {
          this.#cancelFrame = undefined;
          this.#writeReady(TILES_PER_FRAME);
        });
      }
    }
    this.#pump();
  }

  /** Writes up to `limit` landed tiles; the rest wait for the next frame. */
  #writeReady(limit: number): void {
    if (this.#ready.length === 0) return;
    const batch = this.#ready.splice(0, limit);
    this.#write(
      batch.map(({ part, pixels }) => ({
        area: part.area,
        output: new Surface(part.area.width, part.area.height, pixels),
      })),
    );
    for (const { part } of batch) part.written = this.#generation;
    if (this.#ready.length > 0 && this.#schedule !== undefined) {
      this.#cancelFrame ??= this.#schedule(() => {
        this.#cancelFrame = undefined;
        this.#writeReady(TILES_PER_FRAME);
      });
    }
    const done = this.#waiters.filter((waiter) => this.isComplete(waiter.generation));
    this.#waiters = this.#waiters.filter((waiter) => !done.includes(waiter));
    for (const waiter of done) waiter.resolve();
  }
}
