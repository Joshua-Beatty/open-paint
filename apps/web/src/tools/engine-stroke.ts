import {
  type Document,
  EMPTY_RECT,
  intersectRects,
  isEmptyRect,
  type Layer,
  type Rect,
  rectFromEdges,
  Surface,
  TILE_SIZE,
  unionRects,
} from "@openpaint/document";
import type { BrushOptions, StrokeCommit, StrokeMask } from "@openpaint/engine";
import type { EngineStrokeChannel } from "./engine-strokes";
import { type StrokePoint, selectionCoverage } from "./paint-stroke";

/** How often a commit retries while the history is busy (an undo or a background job). */
const RETRY_MS = 50;
const MAX_RETRIES = 200;

let pendingCommits = 0;
let settledWaiters: (() => void)[] = [];

/** Strokes ended but not yet in the history, for the idle and checkpoint checks. */
export function engineStrokesPending(): number {
  return pendingCommits;
}

/**
 * Resolves once every ended engine v2 stroke is in the history (or failed), so Save and Undo act
 * on the document the canvas shows rather than one a stroke readback has not reached yet.
 */
export function engineStrokesSettled(): Promise<void> {
  if (pendingCommits === 0) return Promise.resolve();
  return new Promise((resolve) => settledWaiters.push(resolve));
}

function settleOne(): void {
  pendingCommits -= 1;
  if (pendingCommits > 0) return;
  const waiters = settledWaiters;
  settledWaiters = [];
  for (const resolve of waiters) resolve();
}

export interface EngineStrokeHost {
  /** Runs `callback` before the next repaint; without it, samples go out at once (tests). */
  readonly scheduleFrame?: (callback: () => void) => () => void;
  readonly report: (cause: unknown) => void;
}

/**
 * The selection's coverage over its bounds within the image (TL-FRAME-04), sent once at the
 * start of a stroke. Undefined when nothing is selected.
 */
export function strokeMaskOf(document: Document, pixelated: boolean): StrokeMask | undefined {
  const { selection } = document;
  if (selection.isEmpty) return undefined;
  const b = selection.bounds();
  const area = intersectRects(
    rectFromEdges(
      Math.floor(b.x),
      Math.floor(b.y),
      Math.ceil(b.x + b.width),
      Math.ceil(b.y + b.height),
    ),
    rectFromEdges(0, 0, document.width, document.height),
  );
  if (isEmptyRect(area)) return { x: 0, y: 0, width: 0, height: 0, data: new Uint8Array() };
  const data = selectionCoverage(selection, area, pixelated) ?? new Uint8Array();
  return { x: area.x, y: area.y, width: area.width, height: area.height, data };
}

/** The image rectangle a set of tiles covers, clipped to the layer. */
export function tilesArea(tiles: readonly { tx: number; ty: number }[], bounds: Rect): Rect {
  let area = EMPTY_RECT;
  for (const { tx, ty } of tiles) {
    area = unionRects(
      area,
      rectFromEdges(tx * TILE_SIZE, ty * TILE_SIZE, (tx + 1) * TILE_SIZE, (ty + 1) * TILE_SIZE),
    );
  }
  return intersectRects(area, bounds);
}

/**
 * A Paintbrush or Eraser stroke under engine v2. The main thread only
 * batches samples, at most once per frame, and sends them to the engine, which paints them on the
 * GPU. Nothing touches the document until the end: the engine's painted tiles are recorded as one
 * history item named after the tool, and the document sync is told the engine has them already.
 */
export class EngineStroke {
  readonly #samples: number[] = [];
  #cancelFrame: (() => void) | undefined;
  #open = true;

  constructor(
    readonly channel: EngineStrokeChannel,
    readonly host: EngineStrokeHost,
    readonly document: Document,
    readonly layer: Layer,
    readonly historyName: string,
    options: BrushOptions,
    pixelated: boolean,
    first: StrokePoint,
  ) {
    const mask = strokeMaskOf(document, pixelated);
    channel.begin({ layerId: layer.id, options, ...(mask && { mask }) });
    this.add(first);
  }

  /** Queues a sample; the batch goes to the engine on the next frame. */
  add(point: StrokePoint): void {
    if (!this.#open) return;
    this.#samples.push(point.x, point.y, point.pressure);
    const schedule = this.host.scheduleFrame;
    if (schedule === undefined) {
      this.#flush();
      return;
    }
    this.#cancelFrame ??= schedule(() => {
      this.#cancelFrame = undefined;
      this.#flush();
    });
  }

  /** Sends the last samples, ends the stroke and records it once the engine has read it back. */
  finish(point: StrokePoint): Promise<void> {
    this.add(point);
    this.#unschedule();
    this.#flush();
    this.#open = false;
    pendingCommits += 1;
    return this.channel.end().then(
      (commit) => this.#record(commit, 0),
      (cause: unknown) => {
        settleOne();
        this.host.report(cause);
      },
    );
  }

  cancel(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#unschedule();
    this.channel.cancel();
  }

  #flush(): void {
    if (this.#samples.length === 0) return;
    this.channel.samples(new Float32Array(this.#samples));
    this.#samples.length = 0;
  }

  #unschedule(): void {
    this.#cancelFrame?.();
    this.#cancelFrame = undefined;
  }

  /** Writes the painted tiles as one history item, retrying while the history is busy. */
  #record(commit: StrokeCommit | undefined, attempt: number): void {
    const { document, layer } = this;
    if (commit === undefined || commit.tiles.length === 0 || !document.layers.includes(layer)) {
      settleOne();
      return;
    }
    try {
      document.history.assertIdle();
    } catch (cause) {
      if (attempt >= MAX_RETRIES) {
        settleOne();
        this.host.report(cause);
        return;
      }
      setTimeout(() => this.#record(commit, attempt + 1), RETRY_MS);
      return;
    }
    settleOne();
    const area = tilesArea(commit.tiles, layer.pixels.bounds);
    try {
      this.channel.acknowledge(document, layer.pixels, commit.tiles);
      document.editLayerPixels(this.historyName, layer, area, (pixels) => {
        for (const tile of commit.tiles) {
          const bytes = new Uint8ClampedArray(tile.pixels.buffer as ArrayBuffer);
          const surface = new Surface(TILE_SIZE, TILE_SIZE, bytes);
          pixels.writeRegion(surface, tile.tx * TILE_SIZE, tile.ty * TILE_SIZE);
        }
      });
    } catch (cause) {
      this.host.report(cause);
    }
  }
}
