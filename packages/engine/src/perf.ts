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
  /** Per present in `presents`, 1 when it showed floating content (Move Selected Pixels), else 0. */
  readonly floats?: readonly number[];
  /** Timed stages of engine work since the last report (`perfStages`), in the engine's clock. */
  readonly stages?: readonly PerfStage[];
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
  readonly floats?: number[];
  readonly stages?: PerfStage[];
}

/** A named span of work, for the benchmark's breakdowns. */
export interface PerfStage {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Where stages of engine work are recorded: set while a `PresentRecorder` exists (`?perf=1`), so a
 * timed stage costs one check otherwise.
 */
export const perfStages: { record?: (stage: PerfStage) => void } = {};

/** Runs `work`, recorded as a stage named `name` when the harness records stages. */
export function timedStage<T>(name: string, work: () => T): T {
  const record = perfStages.record;
  if (record === undefined) return work();
  const start = performance.now();
  try {
    return work();
  } finally {
    record({ name, start, end: performance.now() });
  }
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
  #floats: number[] = [];
  #stages: PerfStage[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly emit: (batch: PresentBatch) => void,
    readonly intervalMs = PERF_FLUSH_MS,
  ) {}

  record(start: number, end: number, view?: PresentView, float = false): void {
    this.#presents.push(start, end);
    this.#floats.push(float ? 1 : 0);
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

  /** Keeps a stage of engine work for the next batch. */
  stage(stage: PerfStage): void {
    this.#stages.push(stage);
  }

  take(): PresentBatch {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    const batch = {
      presents: this.#presents,
      views: this.#views,
      floats: this.#floats,
      stages: this.#stages,
    };
    this.#presents = [];
    this.#views = [];
    this.#floats = [];
    this.#stages = [];
    return batch;
  }
}
