/**
 * Pure metrics for the browser benchmark harness. The app records raw
 * timings (`PerfSnapshot`), and the Playwright bench turns them into the scenario metrics here.
 * Every time is in main-thread `performance.now()` milliseconds.
 */

/**
 * One input the main thread saw: a pointer sample (coalesced samples included), a wheel event or a
 * key press.
 */
export interface PerfInput {
  readonly kind: "pointerdown" | "pointermove" | "pointerup" | "keydown" | "wheel";
  /** The event's `timeStamp`. */
  readonly time: number;
  /** True when the input went to the engine canvas. */
  readonly canvas: boolean;
  /** Pointer samples only: true while a button is held (a drag), false for a hover move. */
  readonly drag?: boolean;
}

/** Where a frame showed the image: the device-pixel origin of its corner, and the zoom. */
export interface PerfView {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

/** One present of the engine: when the frame's work began and when the presenter returned. */
export interface PerfPresent {
  readonly start: number;
  readonly end: number;
  /** The view it showed, when the engine had one. */
  readonly view?: PerfView;
}

/** An overlay (the selection outline) drawn over the canvas for a view. */
export interface PerfOverlay {
  readonly time: number;
  readonly view: PerfView;
}

/** An effect preview: when its values were asked for, and when it reached the canvas. */
export interface PerfPreview {
  readonly requested: number;
  readonly shown: number;
}

/** A `longtask` or `long-animation-frame` entry. */
export interface PerfTask {
  readonly start: number;
  readonly duration: number;
  /** `long-animation-frame` only: the part of the frame that blocked input. */
  readonly blockingDuration?: number;
}

/** Everything the app recorded since the last reset, as `__openpaintPerf.snapshot()` returns it. */
export interface PerfSnapshot {
  /** The `?engine=` parameter, `v1` when absent. */
  readonly engine: string;
  readonly presents: readonly PerfPresent[];
  readonly inputs: readonly PerfInput[];
  readonly longTasks: readonly PerfTask[];
  readonly longFrames: readonly PerfTask[];
  /** Overlay draws, for the overlay lag (`overlayLags`). Absent from older recordings. */
  readonly overlays?: readonly PerfOverlay[];
  /**
   * While frame tracking is on (`__openpaintPerf.trackFrames`), the time of the first task after
   * each frame's paint. Absent otherwise.
   */
  readonly paints?: readonly number[];
  /** Effect previews that reached the canvas. Absent from older recordings. */
  readonly previews?: readonly PerfPreview[];
  /** Named times set with `__openpaintPerf.mark()`. */
  readonly marks: Readonly<Record<string, number>>;
  /** Whether the browser reports `longtask` and `long-animation-frame` entries. */
  readonly observes: { readonly longtask: boolean; readonly longAnimationFrame: boolean };
}

/** The p50, p95 and largest of a set of values, or null when it is empty. */
export interface Distribution {
  readonly count: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly max: number | null;
}

/**
 * The `p`th percentile (0 to 100) of `values`, interpolated linearly between the closest ranks.
 * Undefined for an empty set.
 */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const low = sorted[lower] as number;
  const high = sorted[upper] as number;
  return low + (high - low) * (rank - lower);
}

export function distribution(values: readonly number[]): Distribution {
  return {
    count: values.length,
    p50: percentile(values, 50) ?? null,
    p95: percentile(values, 95) ?? null,
    max: values.length === 0 ? null : Math.max(...values),
  };
}

/**
 * The gaps between presents during `[start, end]`, measured at each present's end. The window's
 * edges count as boundaries, so a gesture with no present at all has one gap as long as itself.
 */
export function presentIntervals(
  presents: readonly PerfPresent[],
  start: number,
  end: number,
): number[] {
  const times = presents
    .map((present) => present.end)
    .filter((time) => time >= start && time <= end)
    .sort((a, b) => a - b);
  const edges = [start, ...times, end];
  return edges.slice(1).map((time, index) => time - (edges[index] as number));
}

/**
 * For each input, the time until the end of the first present after it. This approximates
 * input-to-present latency: the engine cannot tell which input a frame shows, so a present that
 * follows an input is taken to include it. Inputs with no later present are left out.
 */
export function inputLatencies(
  inputs: readonly number[],
  presents: readonly PerfPresent[],
): number[] {
  const ends = presents.map((present) => present.end).sort((a, b) => a - b);
  const latencies: number[] = [];
  let next = 0;
  for (const input of [...inputs].sort((a, b) => a - b)) {
    while (next < ends.length && (ends[next] as number) < input) next++;
    if (next >= ends.length) break;
    latencies.push((ends[next] as number) - input);
  }
  return latencies;
}

function sameView(a: PerfView, b: PerfView): boolean {
  return a.x === b.x && a.y === b.y && a.zoom === b.zoom;
}

/**
 * The frame a change made at `time` shows in: the index of the first paint mark at or after it.
 * `paints` are the times of the first task after each main-thread frame's paint, in order. A draw
 * on the main thread before that mark is in that frame's paint, and a worker present that lands
 * before it reaches the display with it.
 */
function frameOf(paints: readonly number[], time: number): number {
  let lo = 0;
  let hi = paints.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((paints[mid] as number) < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * For each new view the engine presented during `[start, end]`, how many frames after it an
 * overlay drew the same view (`paints` as in `frameOf`): 1 means the overlay trailed the canvas by
 * a frame, 0 that they moved together, negative that the overlay led. A view no overlay drew
 * within `horizon` ms counts as the frames of `horizon`.
 */
export function overlayFrameLags(
  presents: readonly PerfPresent[],
  overlays: readonly PerfOverlay[],
  paints: readonly number[],
  start: number,
  end: number,
  horizon = 250,
): number[] {
  return overlayMatches(presents, overlays, start, end, horizon).map(({ present, overlay }) =>
    overlay === undefined
      ? frameOf(paints, present + horizon) - frameOf(paints, present)
      : frameOf(paints, overlay) - frameOf(paints, present),
  );
}

/**
 * How long after the engine presented each new view during `[start, end]` an overlay drew the same
 * view: positive when the overlay trailed the canvas, negative when it was drawn first. A present
 * whose view no overlay drew within `horizon` ms either way counts as `horizon` (it trailed at
 * least that long).
 */
export function overlayLags(
  presents: readonly PerfPresent[],
  overlays: readonly PerfOverlay[],
  start: number,
  end: number,
  horizon = 250,
): number[] {
  return overlayMatches(presents, overlays, start, end, horizon).map(({ present, overlay }) =>
    overlay === undefined ? horizon : overlay - present,
  );
}

/** Each new presented view's time, and the time of the overlay draw of it nearest in time. */
function overlayMatches(
  presents: readonly PerfPresent[],
  overlays: readonly PerfOverlay[],
  start: number,
  end: number,
  horizon: number,
): { present: number; overlay: number | undefined }[] {
  const matches: { present: number; overlay: number | undefined }[] = [];
  let previous: PerfView | undefined;
  for (const present of [...presents].sort((a, b) => a.end - b.end)) {
    const { view } = present;
    if (view === undefined) continue;
    const changed = previous === undefined || !sameView(previous, view);
    previous = view;
    if (!changed || present.end < start || present.end > end) continue;
    let best: number | undefined;
    for (const overlay of overlays) {
      if (!sameView(overlay.view, view)) continue;
      const lag = overlay.time - present.end;
      if (Math.abs(lag) <= horizon && (best === undefined || Math.abs(lag) < Math.abs(best))) {
        best = lag;
      }
    }
    matches.push({
      present: present.end,
      overlay: best === undefined ? undefined : present.end + best,
    });
  }
  return matches;
}

/** The page's own frame rate during a gesture, from `requestAnimationFrame` times. */
export interface FrameStats {
  readonly framesPerSecond: number;
  /** Gaps between frames, with the window's edges as boundaries (as `presentIntervals`). */
  readonly interval: Distribution;
  /** Gaps of 50 ms or more: frames the main thread missed, in browsers without `longtask`. */
  readonly long: number;
  /** The time spent in those gaps. */
  readonly longMs: number;
}

/** The main thread's frames during `[start, end]`, given every animation frame's time. */
export function frameStats(frames: readonly number[], start: number, end: number): FrameStats {
  const inside = frames.filter((time) => time >= start && time <= end).sort((a, b) => a - b);
  const edges = [start, ...inside, end];
  const gaps = edges.slice(1).map((time, index) => time - (edges[index] as number));
  const long = gaps.filter((gap) => gap >= 50);
  const seconds = (end - start) / 1000;
  return {
    framesPerSecond: seconds > 0 ? inside.length / seconds : 0,
    interval: distribution(gaps),
    long: long.length,
    longMs: long.reduce((sum, gap) => sum + gap, 0),
  };
}

/** The tasks that overlap `[start, end]`. */
export function tasksDuring(tasks: readonly PerfTask[], start: number, end: number): PerfTask[] {
  return tasks.filter((task) => task.start < end && task.start + task.duration > start);
}

/** The metrics of one benchmark scenario. Times are milliseconds. */
export interface ScenarioMetrics {
  /** From the first to the last input of the gesture. */
  readonly gestureMs: number;
  readonly inputs: number;
  readonly presents: number;
  readonly presentsPerSecond: number;
  readonly presentInterval: Distribution;
  /** How long each present's frame took on the engine thread, start to end. */
  readonly presentWork: Distribution;
  readonly inputLatency: Distribution;
  /** Main-thread `longtask` entries from the gesture's start until idle. */
  readonly longestTaskMs: number;
  readonly totalLongTaskMs: number;
  /** Main-thread `long-animation-frame` entries over the same span. */
  readonly longestFrameMs: number;
  readonly totalBlockingMs: number;
  /**
   * From the last input until the app was seen idle: no tile work or frame pending in the engine,
   * no history step or effect render in flight. Polled once per frame, so it reads up to about one
   * frame late. Null when the app did not settle within the cap.
   */
  readonly settleMs: number | null;
  /** From the last input to the end of the last present before idle (0 when nothing presented). */
  readonly lastPresentMs: number | null;
  /**
   * For each new view the engine presented during the gesture, how much later an overlay drew it
   * (`overlayLags`). Empty when no overlay recorded its draws.
   */
  readonly overlayLag: Distribution;
  /** The same in frames (`overlayFrameLags`), when frames were tracked. */
  readonly overlayLagFrames: Distribution;
  /** Effect previews that reached the canvas per second of the gesture. */
  readonly previewsPerSecond: number;
  /**
   * For each preview shown from the gesture's start until idle, from when its values were asked
   * for to the end of the first present after it reached the engine: the time to a visible update.
   */
  readonly previewLatency: Distribution;
}

/**
 * For each preview shown during `[start, end]`, the time from its request to the end of the first
 * present at or after it was shown. Previews with no later present are left out.
 */
export function previewLatencies(
  previews: readonly PerfPreview[],
  presents: readonly PerfPresent[],
  start: number,
  end: number,
): number[] {
  const ends = presents.map((present) => present.end).sort((a, b) => a - b);
  const latencies: number[] = [];
  for (const preview of previews) {
    if (preview.shown < start || preview.shown > end) continue;
    const next = ends.find((time) => time >= preview.shown);
    if (next !== undefined) latencies.push(next - preview.requested);
  }
  return latencies;
}

/** The window of a gesture: the inputs between two marks, and when the app was idle after it. */
export interface GestureWindow {
  readonly from: number;
  readonly to: number;
  /** When the app was seen idle, or undefined when it did not settle in time. */
  readonly idleAt: number | undefined;
}

export function scenarioMetrics(snapshot: PerfSnapshot, window: GestureWindow): ScenarioMetrics {
  const inputs = snapshot.inputs
    .map((input) => input.time)
    .filter((time) => time >= window.from && time <= window.to)
    .sort((a, b) => a - b);
  const start = inputs[0] ?? window.from;
  const end = inputs.at(-1) ?? window.to;
  const gestureMs = Math.max(0, end - start);
  const during = snapshot.presents.filter((p) => p.end >= start && p.end <= end);
  const until = window.idleAt ?? Math.max(end, ...snapshot.presents.map((p) => p.end));
  const tasks = tasksDuring(snapshot.longTasks, start, until);
  const frames = tasksDuring(snapshot.longFrames, start, until);
  const settling = snapshot.presents.filter((p) => p.end > end && p.end <= until);
  const lastPresent = Math.max(end, ...settling.map((p) => p.end));
  return {
    gestureMs,
    inputs: inputs.length,
    presents: during.length,
    presentsPerSecond: gestureMs > 0 ? (during.length * 1000) / gestureMs : 0,
    presentInterval: distribution(presentIntervals(snapshot.presents, start, end)),
    presentWork: distribution(during.map((p) => p.end - p.start)),
    inputLatency: distribution(inputLatencies(inputs, snapshot.presents)),
    longestTaskMs: Math.max(0, ...tasks.map((task) => task.duration)),
    totalLongTaskMs: tasks.reduce((sum, task) => sum + task.duration, 0),
    longestFrameMs: Math.max(0, ...frames.map((frame) => frame.duration)),
    totalBlockingMs: frames.reduce((sum, frame) => sum + (frame.blockingDuration ?? 0), 0),
    settleMs: window.idleAt === undefined ? null : window.idleAt - end,
    lastPresentMs: window.idleAt === undefined ? null : lastPresent - end,
    overlayLag: distribution(
      (snapshot.overlays ?? []).length === 0
        ? []
        : overlayLags(snapshot.presents, snapshot.overlays ?? [], start, end),
    ),
    overlayLagFrames: distribution(
      (snapshot.overlays ?? []).length === 0 || (snapshot.paints ?? []).length === 0
        ? []
        : overlayFrameLags(
            snapshot.presents,
            snapshot.overlays ?? [],
            snapshot.paints ?? [],
            start,
            end,
          ),
    ),
    previewsPerSecond:
      gestureMs > 0
        ? ((snapshot.previews ?? []).filter((p) => p.shown >= start && p.shown <= end).length *
            1000) /
          gestureMs
        : 0,
    previewLatency: distribution(
      previewLatencies(snapshot.previews ?? [], snapshot.presents, start, until),
    ),
  };
}
