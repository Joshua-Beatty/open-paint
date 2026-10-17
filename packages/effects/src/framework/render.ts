import {
  intersectRects,
  isEmptyRect,
  type MemoryAccountant,
  type Rect,
  rect,
  type Surface,
  type TiledPixelStore,
} from "@openpaint/document";
import { clipToCoverageArea } from "../apply";
import type { EffectBinding } from "./binding";
import type { CpuOffloader } from "./cpu-offload";
import { EffectError, toEffectError } from "./errors";
import type { GpuOffloader } from "./gpu-offload";

/** Output is written in tiles of the store's grid, so one write touches whole store tiles. */
export const RENDER_TILE_SIZE = 256;
/** Progress and repaint notifications are throttled to this interval (FX-FW-PREVIEW-01). */
export const PROGRESS_INTERVAL_MS = 1000;
/** `onWrite` is called at most this often while tiles are written, about once per frame. */
export const WRITE_NOTIFY_INTERVAL_MS = 16;
/**
 * Output tiles are written for up to this long between two yields to the host. Yielding after each
 * tile cost more than the writes: a timer yield waits at least 4 ms once nested, so a 4000x3000
 * preview (192 tiles) took over 0.8 s to land (L10).
 */
export const WRITE_SLICE_MS = 8;
/** The scratch copy of the original and the output, RGBA8 each (FX-FW-ERR-01). */
const SCRATCH_BYTES_PER_PIXEL = 8;

export type RenderBackend = "cpu" | "gpu";
/**
 * "canceled" means the render stopped, and the region was restored to its original pixels unless
 * the request said not to (`restoreOnCancel`).
 */
export type RenderOutcome = "done" | "canceled";

export interface RenderRequest<P> {
  readonly binding: EffectBinding<P>;
  readonly params: P;
  readonly store: TiledPixelStore;
  /** The area to render. It lies inside the store. */
  readonly region: Rect;
  /** The pixels of `region` before any preview. Restored on cancel or failure. */
  readonly original: Surface;
  /** Per-pixel selection coverage over `region`, 0-255. Undefined means the whole region. */
  readonly coverage?: ArrayLike<number>;
  /**
   * Whether the output is mixed with the original by coverage (FX-FW-SEL-01). An effect that
   * disables selection clipping still gets the coverage and masks itself. Defaults to true.
   */
  readonly clipsOutput?: boolean;
  /** Prefer the GPU implementation when the binding has one (WEB-GPU-01). */
  readonly backend: RenderBackend;
  /** Runs the CPU implementation off this thread when it can (PRD-NF-02). Undefined runs it here. */
  readonly offload?: CpuOffloader;
  /**
   * Runs the WGSL implementation on the engine's device when `backend` is "gpu" (WEB-GPU-01). It
   * comes before the binding's own `gpu`. A failure falls back to the CPU (WEB-GPU-04).
   */
  readonly gpu?: GpuOffloader;
  readonly accountant?: MemoryAccountant;
  readonly signal: AbortSignal;
  /** Tiles nearest this rectangle are written first, so the visible part shows up first. */
  readonly priority?: Rect;
  /** Percent of the output written, or undefined while the effect is being computed. */
  readonly onProgress?: (percent: number | undefined) => void;
  /**
   * Called after pixels were written into the store, so the host can show them: output tiles (at
   * most once per `WRITE_NOTIFY_INTERVAL_MS`, and always after the last tile) and the original when
   * it is restored. It must not throw.
   */
  readonly onWrite?: () => void;
  /**
   * Whether a canceled render writes the original back. Defaults to true. A live preview that the
   * next one replaces passes false, so the canvas keeps the last preview until the new tiles arrive.
   * Its owner then restores the original itself when the preview is canceled. Failures always restore.
   */
  readonly restoreOnCancel?: boolean;
  /**
   * Writes every tile in one task, with one `onWrite` after the last, instead of in time slices.
   * For a commit whose result the canvas already shows as a live filter: the filter comes down in
   * the same task as the pixels go up, so the canvas never shows a mix of the two.
   */
  readonly atOnce?: boolean;
  readonly log?: (message: string, cause: unknown) => void;
  readonly clock?: () => number;
  readonly yieldToHost?: () => Promise<void>;
}

/** The store tiles that cover `region`, each clipped to it. */
export function tileRects(region: Rect, size: number = RENDER_TILE_SIZE): Rect[] {
  const tiles: Rect[] = [];
  const right = region.x + region.width;
  const bottom = region.y + region.height;
  for (let y = Math.floor(region.y / size) * size; y < bottom; y += size) {
    for (let x = Math.floor(region.x / size) * size; x < right; x += size) {
      tiles.push(intersectRects(rect(x, y, size, size), region));
    }
  }
  return tiles;
}

/** Sorts tiles so the ones nearest `priority` come first. The sort is stable. */
export function orderTiles(tiles: readonly Rect[], priority?: Rect): Rect[] {
  if (priority === undefined) return [...tiles];
  const cx = priority.x + priority.width / 2;
  const cy = priority.y + priority.height / 2;
  const distance = (tile: Rect) =>
    (tile.x + tile.width / 2 - cx) ** 2 + (tile.y + tile.height / 2 - cy) ** 2;
  return [...tiles].sort((a, b) => distance(a) - distance(b));
}

const defaultYield = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Renders one region of a layer in place (FX-FW-PREVIEW-01, FX-FW-SEL-01, FX-FW-ERR-01). The effect
 * is computed once over the region, on the GPU when available and otherwise on the CPU, and the
 * result is masked by coverage. It is then written tile by tile, checking for cancellation between
 * tiles, and `onWrite` reports the written tiles as they land. Cancellation and failure restore the
 * original pixels, so the layer is never left half-rendered, except that a canceled live preview
 * may keep its tiles for the next one (`restoreOnCancel`). Nothing is recorded in history here.
 */
export async function renderRegion<P>(request: RenderRequest<P>): Promise<RenderOutcome> {
  const { binding, accountant, signal, region } = request;
  if (isEmptyRect(region)) return "done";
  if (signal.aborted) return "canceled";
  const scratch = region.width * region.height * SCRATCH_BYTES_PER_PIXEL;
  if (accountant !== undefined && !accountant.canReserve(scratch)) {
    throw new EffectError(binding.descriptor.id, "outOfMemory");
  }
  accountant?.reserve(scratch);
  try {
    return await renderReserved(request);
  } finally {
    accountant?.release(scratch);
  }
}

async function renderReserved<P>(request: RenderRequest<P>): Promise<RenderOutcome> {
  const { binding, store, region, original, signal } = request;
  const id = binding.descriptor.id;
  const clock = request.clock ?? Date.now;
  let unshown = false;
  let lastShown = Number.NEGATIVE_INFINITY;
  const show = (force: boolean) => {
    const now = clock();
    if (!force && now - lastShown < WRITE_NOTIFY_INTERVAL_MS) {
      unshown = true;
      return;
    }
    lastShown = now;
    unshown = false;
    request.onWrite?.();
  };
  const restore = () => {
    store.writeRegion(original, region.x, region.y);
    show(true);
  };
  const stop = (): RenderOutcome => {
    if (request.restoreOnCancel === false) {
      if (unshown) show(true);
    } else {
      restore();
    }
    return "canceled";
  };
  const yieldToHost = request.yieldToHost ?? defaultYield;
  let effected: Surface;
  try {
    effected = await compute(request);
  } catch (cause) {
    // A superseded preview stops at once and leaves its tiles for the next one, as a cancel does.
    if (signal.aborted) return stop();
    restore();
    throw toEffectError(id, cause);
  }
  if (signal.aborted) return stop();
  if (effected.width !== region.width || effected.height !== region.height) {
    restore();
    throw new EffectError(
      id,
      "failed",
      new RangeError(
        `Effect returned ${effected.width}x${effected.height} for a region of ${region.width}x${region.height}.`,
      ),
    );
  }
  const clipCoverage = request.clipsOutput === false ? undefined : request.coverage;
  const tiles = orderTiles(tileRects(region), request.priority);
  const total = region.width * region.height;
  let written = 0;
  let lastReport = Number.NEGATIVE_INFINITY;
  const report = (percent: number | undefined, force: boolean) => {
    const now = clock();
    if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return;
    lastReport = now;
    request.onProgress?.(percent);
  };
  report(0, true);
  let sliceStart = clock();
  for (const tile of tiles) {
    if (signal.aborted) return stop();
    try {
      const local = rect(tile.x - region.x, tile.y - region.y, tile.width, tile.height);
      // Each tile is clipped just before it is written, inside the time slice (L7, L10).
      if (clipCoverage === undefined) store.writeRegion(effected, tile.x, tile.y, local);
      else
        store.writeRegion(
          clipToCoverageArea(original, effected, clipCoverage, local),
          tile.x,
          tile.y,
        );
    } catch (cause) {
      restore();
      throw toEffectError(id, cause);
    }
    written += tile.width * tile.height;
    if (request.atOnce === true) {
      unshown = true;
      continue;
    }
    show(false);
    report(Math.floor((written * 100) / total), false);
    if (clock() - sliceStart >= WRITE_SLICE_MS) {
      await yieldToHost();
      sliceStart = clock();
    }
  }
  if (unshown) show(true);
  report(100, true);
  return "done";
}

/**
 * Runs the effect on the GPU when it can, on the engine's device or with the binding's own
 * implementation, falling back to the CPU on any failure. The CPU run goes to the offloader when it
 * has the binding, so the main thread stays free. A canceled GPU run does not fall back.
 */
async function compute<P>(request: RenderRequest<P>): Promise<Surface> {
  const { binding, params, original, backend, coverage, offload, gpu, signal } = request;
  if (backend === "gpu") {
    const own = binding.gpu;
    const run =
      gpu?.canRun(binding) === true
        ? () => gpu.run(binding, original, params, coverage, signal)
        : own === undefined
          ? undefined
          : () => own.call(binding, original, params, coverage);
    if (run !== undefined) {
      try {
        return await run();
      } catch (cause) {
        if (signal.aborted) throw cause;
        request.log?.(`The GPU render of "${binding.descriptor.id}" failed; using the CPU.`, cause);
      }
    }
  }
  if (offload?.canRun(binding) === true) {
    return offload.run(binding, original, params, coverage, signal);
  }
  return binding.cpu(original, params, coverage);
}
