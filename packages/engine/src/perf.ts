/**
 * Present timings for the browser benchmark harness. The engine creates a
 * recorder only when the app runs with `?perf=1`. Otherwise every hook is skipped behind a single
 * undefined check.
 */

/** What the engine reports to the main thread, as a `perf` event or a `perf` reply. */
export interface EnginePerfReport {
  /** `performance.timeOrigin` of the engine's scope. Add it to a time to compare across threads. */
  readonly timeOrigin: number;
  /**
   * Presents since the last report, as flat `[start, end]` pairs in the engine's
   * `performance.now()` milliseconds. `start` is when the frame began (tile building included) and
   * `end` is when the presenter returned.
   */
  readonly presents: readonly number[];
  /**
   * The view each present showed, as flat `[originX, originY, zoom]` triples in the order of
   * `presents`, or NaN when the engine had no layout yet. The bench compares them with what the
   * overlays drew, to see whether the two move together.
   */
  readonly views?: readonly number[];
  /** True when the engine has no tile builds pending and no frame scheduled. */
  readonly idle: boolean;
}

/** The view of one present: where the image's corner was, and the zoom. */
export interface PresentView {
  readonly originX: number;
  readonly originY: number;
  readonly zoom: number;
}

/** Presents recorded since the last batch (`EnginePerfReport`). */
export interface PresentBatch {
  readonly presents: number[];
  readonly views: number[];
}

/** The user timing measure each recorded present leaves on the engine thread. */
export const PRESENT_MEASURE = "openpaint:engine present";

/** How long recorded presents may wait before the recorder sends them on its own. */
export const PERF_FLUSH_MS = 250;

/**
 * Collects present timings and hands them to `emit` in batches, at most once per `intervalMs`.
 * `take` drains the batch at once, for a `perf` request.
 */
export class PresentRecorder {
  #presents: number[] = [];
  #views: number[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly emit: (batch: PresentBatch) => void,
    readonly intervalMs = PERF_FLUSH_MS,
  ) {}

  record(start: number, end: number, view?: PresentView): void {
    this.#presents.push(start, end);
    this.#views.push(
      view?.originX ?? Number.NaN,
      view?.originY ?? Number.NaN,
      view?.zoom ?? Number.NaN,
    );
    // A user timing measure puts the frame into performance traces (`pnpm lag`, DevTools).
    performance.measure(PRESENT_MEASURE, { start, end });
    performance.clearMeasures(PRESENT_MEASURE);
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      const batch = this.take();
      if (batch.presents.length > 0) this.emit(batch);
    }, this.intervalMs);
  }

  take(): PresentBatch {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    const batch = { presents: this.#presents, views: this.#views };
    this.#presents = [];
    this.#views = [];
    return batch;
  }
}
