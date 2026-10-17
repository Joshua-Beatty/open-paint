import type { PerfInput, PerfPresent, PerfTask } from "../src/perf/stats.ts";

/**
 * Pure analysis of a `pnpm lag` recording: a Chrome trace plus what the app's perf monitor saw.
 * It finds the lag spikes, groups overlapping ones into incidents, and attributes each incident to
 * the functions that ran in it, from the CPU profile samples in the trace. Trace times are in
 * microseconds; the app's times are main-thread `performance.now()` milliseconds and are moved onto
 * the trace clock with the clock mark the recorder left in both.
 */

/** Anything that takes this long, or makes the user wait this long, is a lag spike. */
export const LAG_MS = 50;

/** A drag or wheel burst that saw no present until this long after it ended did not draw through the engine. */
const PRESENT_GRACE_MS = 250;

/** How long one wheel event keeps input "active". */
const WHEEL_ACTIVE_MS = 100;

/** An input's latency counts only if its present came at most this long after its gesture ended. */
const LATENCY_HORIZON_MS = 1000;

/** A drag shorter than this is called a click. */
const CLICK_MS = 300;

/** The user timing mark the recorder sets to line up the page's clock with the trace's. */
export const CLOCK_MARK = "openpaint:lag-clock";

/** The user timing measure the engine leaves for every present (packages/engine/src/perf.ts). */
export const PRESENT_MEASURE = "openpaint:engine present";

export interface TraceEvent {
  readonly name: string;
  readonly cat?: string;
  readonly ph: string;
  readonly ts: number;
  readonly dur?: number;
  readonly pid: number;
  readonly tid: number;
  readonly id?: string | number;
  readonly args?: Record<string, unknown>;
}

/** When the active tool changed, read from the Tools panel (`[role=radio][aria-checked=true]`). */
export interface ToolChange {
  /** Main-thread `performance.now()` milliseconds. */
  readonly time: number;
  readonly tool: string;
}

/** What the page recorded during the session, on the main thread's clock (milliseconds). */
export interface AppRecording {
  readonly presents: readonly PerfPresent[];
  readonly inputs: readonly PerfInput[];
  readonly longTasks: readonly PerfTask[];
  readonly longFrames: readonly PerfTask[];
  readonly tools: readonly ToolChange[];
  /** The page time of `CLOCK_MARK`, or undefined when the page never got that far. */
  readonly clockTime: number | undefined;
  /** The page time the engine had started (the canvas reports a backend). Lag before it is loading. */
  readonly readyTime?: number;
}

export type ThreadName = "main" | "engine";

export interface ThreadId {
  readonly pid: number;
  readonly tid: number;
}

export interface Threads {
  readonly main: ThreadId | undefined;
  readonly engine: ThreadId | undefined;
}

export type SpikeKind = "task" | "frame" | "present-gap" | "latency";

/** One lag signal. Times are trace microseconds. */
export interface Spike {
  readonly kind: SpikeKind;
  /** Where it was measured: tasks on their thread, frames on main, gaps and latency at the engine. */
  readonly thread: ThreadName;
  readonly start: number;
  readonly end: number;
  readonly durationMs: number;
  /** Long animation frames: the blocking part. Latency: how many inputs waited this long. */
  readonly extra?: number;
}

/** A V8 call frame. Lines and columns are 0-based; VM entries have no URL or position. */
export interface CallFrame {
  readonly functionName: string;
  readonly url?: string;
  readonly lineNumber?: number;
  readonly columnNumber?: number;
  readonly scriptId?: number | string;
  readonly codeType?: string;
}

/** Where a profiled function lives, after source maps. */
export interface ResolvedFrame {
  readonly name: string;
  /** `file:line`, or empty for VM entries such as `(garbage collector)`. */
  readonly location: string;
  /** app (our TypeScript), wasm (our Rust), bundle (our bundle, unmapped), lib or vm. */
  readonly origin: "app" | "wasm" | "bundle" | "lib" | "vm";
}

export type FrameResolver = (frame: CallFrame) => ResolvedFrame;

export interface FunctionTime extends ResolvedFrame {
  readonly ms: number;
}

/** One thread's share of an incident. */
export interface ThreadAttribution {
  readonly thread: ThreadName;
  /** Sampled time that was not idle. */
  readonly busyMs: number;
  /** Ours first, each group by time. */
  readonly self: readonly FunctionTime[];
  readonly inclusive: readonly FunctionTime[];
}

/** Overlapping spikes, reported as one. */
export interface Incident {
  readonly start: number;
  readonly end: number;
  /** The longest of its spikes. */
  readonly durationMs: number;
  readonly spikes: readonly Spike[];
  /** The thread the lag happened on: a long task's own thread, else the busier one. */
  readonly thread: ThreadName;
  readonly activity: string;
  readonly tool: string | undefined;
  readonly threads: readonly ThreadAttribution[];
}

export interface ThreadSummary {
  readonly thread: ThreadName;
  readonly longTasks: number;
  readonly longTaskMs: number;
  readonly longestTaskMs: number;
  /** The part of each long task over 50 ms, summed. */
  readonly blockingMs: number;
}

export interface LagAnalysis {
  readonly threads: Threads;
  /** Trace microseconds of the session's first event. */
  readonly start: number;
  readonly end: number;
  readonly sessionMs: number;
  /** Whether the app's clock could be lined up with the trace (frames, presents and input). */
  readonly clockAligned: boolean;
  /** Whether the trace has CPU samples for the main thread and the engine. */
  readonly profiled: Readonly<Record<ThreadName, boolean>>;
  readonly taskSummary: readonly ThreadSummary[];
  readonly spikeCounts: Readonly<Record<SpikeKind, number>>;
  readonly incidents: readonly Incident[];
  /** Across all incidents. */
  readonly hot: readonly ThreadAttribution[];
}

const TASK_NAMES = new Set(["RunTask", "ThreadControllerImpl::RunTask"]);

function isUserTiming(event: TraceEvent): boolean {
  return event.cat?.split(",").includes("blink.user_timing") ?? false;
}

function eventData(event: TraceEvent): Record<string, unknown> | undefined {
  return event.args?.data as Record<string, unknown> | undefined;
}

/** Whether `url` is the engine worker's script (`worker.ts` in dev, `assets/worker-<hash>.js` built). */
export function isEngineWorkerUrl(url: string): boolean {
  return /\/worker(?:-[\w-]+)?\.(?:js|ts)(?:\?|$)/.test(url) || /engine\/src\/worker\.ts/.test(url);
}

/**
 * The page's main thread is the one with the recorder's clock mark (or, without it, the renderer
 * main thread that ran the most). The engine worker is the thread that left present measures, or
 * the dedicated worker whose script is the engine's.
 */
export function findThreads(events: readonly TraceEvent[]): Threads {
  let main: ThreadId | undefined;
  let engine: ThreadId | undefined;
  for (const event of events) {
    if (!isUserTiming(event)) continue;
    if (main === undefined && event.name === CLOCK_MARK) main = { pid: event.pid, tid: event.tid };
    if (engine === undefined && event.name === PRESENT_MEASURE) {
      engine = { pid: event.pid, tid: event.tid };
    }
  }
  if (main === undefined) {
    const names = threadNames(events);
    const busy = new Map<string, number>();
    for (const event of events) {
      if (!TASK_NAMES.has(event.name)) continue;
      const key = `${event.pid}:${event.tid}`;
      if (names.get(key) !== "CrRendererMain") continue;
      busy.set(key, (busy.get(key) ?? 0) + (event.dur ?? 0));
    }
    const best = [...busy].sort((a, b) => b[1] - a[1])[0];
    if (best !== undefined) {
      const [pid, tid] = best[0].split(":").map(Number) as [number, number];
      main = { pid, tid };
    }
  }
  if (engine === undefined) {
    for (const event of events) {
      if (event.name !== "TracingSessionIdForWorker") continue;
      const data = eventData(event);
      const url = typeof data?.url === "string" ? data.url : "";
      const tid = data?.workerThreadId;
      if (typeof tid === "number" && isEngineWorkerUrl(url)) {
        engine = { pid: main?.pid ?? event.pid, tid };
        break;
      }
    }
  }
  return { main, engine };
}

function threadNames(events: readonly TraceEvent[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const event of events) {
    if (event.ph === "M" && event.name === "thread_name") {
      names.set(`${event.pid}:${event.tid}`, String(event.args?.name ?? ""));
    }
  }
  return names;
}

function same(thread: ThreadId | undefined, event: { pid: number; tid: number }): boolean {
  return thread !== undefined && thread.pid === event.pid && thread.tid === event.tid;
}

/** Top-level tasks of `thread` (nested tasks are dropped), in trace microseconds. */
export function threadTasks(
  events: readonly TraceEvent[],
  thread: ThreadId | undefined,
): { start: number; end: number }[] {
  const tasks = events
    .filter((event) => TASK_NAMES.has(event.name) && event.ph === "X" && same(thread, event))
    .map((event) => ({ start: event.ts, end: event.ts + (event.dur ?? 0) }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const top: { start: number; end: number }[] = [];
  for (const task of tasks) {
    const last = top.at(-1);
    if (last !== undefined && task.start < last.end) continue;
    top.push(task);
  }
  return top;
}

/** One sampled CPU profile of a thread. Sample times are trace microseconds, sorted. */
export interface CpuProfile {
  readonly thread: ThreadId;
  readonly nodes: ReadonlyMap<
    number,
    { readonly parent: number | undefined; readonly frame: CallFrame }
  >;
  readonly times: readonly number[];
  readonly samples: readonly number[];
}

interface ProfileNodeJson {
  readonly id: number;
  readonly parent?: number;
  readonly callFrame: CallFrame;
}

/** Rebuilds the CPU profiles from the trace's `Profile` and `ProfileChunk` events. */
export function parseProfiles(events: readonly TraceEvent[]): CpuProfile[] {
  const building = new Map<
    string,
    {
      thread: ThreadId;
      time: number;
      nodes: Map<number, { parent: number | undefined; frame: CallFrame }>;
      times: number[];
      samples: number[];
    }
  >();
  const chunks: TraceEvent[] = [];
  for (const event of events) {
    if (event.name === "Profile") {
      const data = eventData(event);
      building.set(`${event.pid}:${String(event.id)}`, {
        thread: { pid: event.pid, tid: event.tid },
        time: typeof data?.startTime === "number" ? data.startTime : event.ts,
        nodes: new Map(),
        times: [],
        samples: [],
      });
    } else if (event.name === "ProfileChunk") chunks.push(event);
  }
  for (const chunk of chunks) {
    const profile = building.get(`${chunk.pid}:${String(chunk.id)}`);
    const data = eventData(chunk);
    if (profile === undefined || data === undefined) continue;
    const cpu = data.cpuProfile as
      | { nodes?: readonly ProfileNodeJson[]; samples?: readonly number[] }
      | undefined;
    for (const node of cpu?.nodes ?? []) {
      profile.nodes.set(node.id, { parent: node.parent, frame: node.callFrame });
    }
    const deltas = (data.timeDeltas as readonly number[] | undefined) ?? [];
    const samples = cpu?.samples ?? [];
    for (const [index, sample] of samples.entries()) {
      profile.time += deltas[index] ?? 0;
      profile.times.push(profile.time);
      profile.samples.push(sample);
    }
  }
  return [...building.values()].map(({ thread, nodes, times, samples }) => {
    // Samples can arrive slightly out of order across chunks.
    const order = times
      .map((_, index) => index)
      .sort((a, b) => (times[a] as number) - (times[b] as number));
    return {
      thread,
      nodes,
      times: order.map((index) => times[index] as number),
      samples: order.map((index) => samples[index] as number),
    };
  });
}

/** VM entries that are not running code at all. */
const IDLE_NAMES = new Set(["(idle)", "(root)"]);

/** VM entries that are time spent but not in a function of ours or a library's. */
const VM_NAMES = new Set(["(program)", "(garbage collector)", "(idle)", "(root)"]);

interface FunctionTotals {
  busyUs: number;
  self: Map<string, { frame: ResolvedFrame; us: number }>;
  inclusive: Map<string, { frame: ResolvedFrame; us: number }>;
}

function frameKey(frame: ResolvedFrame): string {
  return `${frame.name}\u0000${frame.location}`;
}

/**
 * Adds the samples of `profile` that fall in `windows` (trace microseconds) to `totals`. A sample
 * lasts until the next one; the last sample lasts as long as the median interval.
 */
function addSamples(
  totals: FunctionTotals,
  profile: CpuProfile,
  windows: readonly { start: number; end: number }[],
  resolve: (nodeId: number) => ResolvedFrame,
  stack: (nodeId: number) => readonly ResolvedFrame[],
): void {
  const { times, samples } = profile;
  const intervals = times.slice(1).map((time, index) => time - (times[index] as number));
  const typical =
    intervals.length > 0
      ? ([...intervals].sort((a, b) => a - b)[intervals.length >> 1] as number)
      : 0;
  for (const window of windows) {
    let index = lowerBound(times, window.start);
    // The sample just before the window may run into it.
    if (index > 0) index--;
    for (; index < times.length; index++) {
      const start = times[index] as number;
      if (start >= window.end) break;
      const end = index + 1 < times.length ? (times[index + 1] as number) : start + typical;
      const overlap = Math.min(end, window.end) - Math.max(start, window.start);
      if (overlap <= 0) continue;
      const node = samples[index] as number;
      const leaf = resolve(node);
      if (IDLE_NAMES.has(leaf.name)) continue;
      totals.busyUs += overlap;
      add(totals.self, leaf, overlap);
      const seen = new Set<string>();
      for (const frame of stack(node)) {
        const key = frameKey(frame);
        if (seen.has(key) || IDLE_NAMES.has(frame.name)) continue;
        seen.add(key);
        add(totals.inclusive, frame, overlap);
      }
    }
  }
}

function add(map: FunctionTotals["self"], frame: ResolvedFrame, us: number): void {
  const key = frameKey(frame);
  const entry = map.get(key);
  if (entry) entry.us += us;
  else map.set(key, { frame, us });
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((values[mid] as number) < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

const OURS = new Set<ResolvedFrame["origin"]>(["app", "wasm", "bundle"]);

/** Our functions first (the top `ours` by time), then the top `others` of the rest. */
export function rankFunctions(
  entries: Iterable<{ frame: ResolvedFrame; us: number }>,
  ours = 6,
  others = 4,
): FunctionTime[] {
  const list = [...entries]
    .map(({ frame, us }) => ({ ...frame, ms: us / 1000 }))
    .sort((a, b) => b.ms - a.ms || a.name.localeCompare(b.name));
  return [
    ...list.filter((entry) => OURS.has(entry.origin)).slice(0, ours),
    ...list.filter((entry) => !OURS.has(entry.origin)).slice(0, others),
  ];
}

/** The fallback resolver: the frame's own name and URL path, with no source maps. */
export function plainResolver(frame: CallFrame): ResolvedFrame {
  const name = frame.functionName || "(anonymous)";
  const url = frame.url ?? "";
  if (VM_NAMES.has(name) || (url === "" && name.startsWith("("))) {
    return { name, location: "", origin: "vm" };
  }
  if (url === "") return { name, location: "(native)", origin: "vm" };
  const line = (frame.lineNumber ?? 0) + 1;
  if (url.startsWith("wasm://")) {
    return {
      name,
      location: `${url.replace(/^wasm:\/\/wasm\//, "wasm:")}:${frame.functionName}`,
      origin: "wasm",
    };
  }
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Not a URL: keep it.
  }
  if (path.endsWith(".wasm"))
    return { name, location: path.split("/").at(-1) ?? path, origin: "wasm" };
  const location = `${shortPath(path)}:${line}:${(frame.columnNumber ?? 0) + 1}`;
  if (/node_modules|\/@vite\/|\/\.vite\/deps\//.test(path))
    return { name, location, origin: "lib" };
  if (/\/(?:src|packages|apps)\//.test(path)) return { name, location, origin: "app" };
  return { name, location, origin: "bundle" };
}

/** A dependency's path from its package name on (`react-dom/cjs/...`), else `path`. */
export function shortPath(path: string): string {
  const index = path.lastIndexOf("node_modules/");
  return index < 0 ? path : path.slice(index + "node_modules/".length);
}

/** Attributes the samples of the thread's profile(s) in `windows`. */
class ThreadProfiler {
  readonly #profiles: readonly CpuProfile[];
  readonly #resolved = new Map<CpuProfile, Map<number, ResolvedFrame>>();
  readonly #stacks = new Map<CpuProfile, Map<number, ResolvedFrame[]>>();
  readonly thread: ThreadName;
  readonly resolver: FrameResolver;

  constructor(thread: ThreadName, profiles: readonly CpuProfile[], resolver: FrameResolver) {
    this.thread = thread;
    this.#profiles = profiles;
    this.resolver = resolver;
  }

  get sampled(): boolean {
    return this.#profiles.some((profile) => profile.samples.length > 0);
  }

  attribute(
    windows: readonly { start: number; end: number }[],
    ours = 6,
    others = 4,
  ): ThreadAttribution {
    const totals: FunctionTotals = { busyUs: 0, self: new Map(), inclusive: new Map() };
    for (const profile of this.#profiles) {
      addSamples(
        totals,
        profile,
        windows,
        (node) => this.#resolve(profile, node),
        (node) => this.#stack(profile, node),
      );
    }
    return {
      thread: this.thread,
      busyMs: totals.busyUs / 1000,
      self: rankFunctions(totals.self.values(), ours, others),
      inclusive: rankFunctions(totals.inclusive.values(), ours, others),
    };
  }

  #resolve(profile: CpuProfile, node: number): ResolvedFrame {
    let cache = this.#resolved.get(profile);
    if (cache === undefined) {
      cache = new Map();
      this.#resolved.set(profile, cache);
    }
    let frame = cache.get(node);
    if (frame === undefined) {
      const entry = profile.nodes.get(node);
      frame = entry
        ? this.resolver(entry.frame)
        : { name: "(unknown)", location: "", origin: "vm" };
      cache.set(node, frame);
    }
    return frame;
  }

  #stack(profile: CpuProfile, node: number): ResolvedFrame[] {
    let cache = this.#stacks.get(profile);
    if (cache === undefined) {
      cache = new Map();
      this.#stacks.set(profile, cache);
    }
    const cached = cache.get(node);
    if (cached !== undefined) return cached;
    const stack: ResolvedFrame[] = [];
    let current: number | undefined = node;
    const visited = new Set<number>();
    while (current !== undefined && !visited.has(current)) {
      visited.add(current);
      stack.push(this.#resolve(profile, current));
      current = profile.nodes.get(current)?.parent;
    }
    cache.set(node, stack);
    return stack;
  }
}

interface Interval {
  readonly start: number;
  readonly end: number;
}

interface Gesture extends Interval {
  readonly kind: "drag" | "wheel";
  readonly canvas: boolean;
  /** The inputs that expect the canvas to update, in trace microseconds. */
  readonly inputs: readonly number[];
}

/** Drags (pointer down to up) and bursts of wheel events, in trace microseconds. */
export function gestures(inputs: readonly PerfInput[], toTrace: (ms: number) => number): Gesture[] {
  const sorted = [...inputs].sort((a, b) => a.time - b.time);
  const result: Gesture[] = [];
  let drag: { start: number; canvas: boolean; inputs: number[]; last: number } | undefined;
  let wheel: { start: number; end: number; canvas: boolean; inputs: number[] } | undefined;
  const closeWheel = () => {
    if (wheel) result.push({ kind: "wheel", ...wheel });
    wheel = undefined;
  };
  for (const input of sorted) {
    const time = toTrace(input.time);
    if (input.kind === "wheel") {
      const end = time + WHEEL_ACTIVE_MS * 1000;
      if (wheel && time <= wheel.end && wheel.canvas === input.canvas) {
        wheel.end = end;
        wheel.inputs.push(time);
      } else {
        closeWheel();
        wheel = { start: time, end, canvas: input.canvas, inputs: [time] };
      }
    } else if (input.kind === "pointerdown" && input.drag !== false) {
      if (drag)
        result.push({
          kind: "drag",
          start: drag.start,
          end: drag.last,
          canvas: drag.canvas,
          inputs: drag.inputs,
        });
      drag = { start: time, canvas: input.canvas, inputs: [time], last: time };
    } else if (input.kind === "pointermove" && drag && input.drag !== false) {
      drag.inputs.push(time);
      drag.last = time;
    } else if (input.kind === "pointerup" && drag) {
      result.push({
        kind: "drag",
        start: drag.start,
        end: time,
        canvas: drag.canvas,
        inputs: drag.inputs,
      });
      drag = undefined;
    }
  }
  closeWheel();
  if (drag)
    result.push({
      kind: "drag",
      start: drag.start,
      end: drag.last,
      canvas: drag.canvas,
      inputs: drag.inputs,
    });
  return result.sort((a, b) => a.start - b.start);
}

/**
 * The gap spike between two presents, if the inputs that came between them were owed a present for
 * at least `LAG_MS` in total. Each input is owed one from when it came until `LAG_MS` later or the
 * next present, so a pause in a drag (the button held, the pointer still) owes nothing.
 */
function gapSpike(inputs: readonly number[], next: number): Spike | undefined {
  const lag = LAG_MS * 1000;
  let owed = 0;
  let covered = Number.NEGATIVE_INFINITY;
  for (const input of inputs) {
    const end = Math.min(input + lag, next);
    owed += Math.max(0, end - Math.max(input, covered));
    covered = Math.max(covered, end);
  }
  const first = inputs[0];
  if (first === undefined || owed < lag) return undefined;
  const end = Math.min(next, covered);
  return {
    kind: "present-gap",
    thread: "engine",
    start: first,
    end,
    durationMs: (end - first) / 1000,
  };
}

/**
 * Gaps between presents in which the user kept giving input for at least `LAG_MS` without the
 * canvas updating, and inputs that waited at least `LAG_MS` for the next present. Only drags and
 * canvas wheel bursts count. A gesture that saw no present at all until shortly after it ended (a
 * selection outline drawn on the overlay, a panel scroll) does not draw through the engine and is
 * judged by tasks and frames only.
 */
export function presentSpikes(
  presentEnds: readonly number[],
  active: readonly Gesture[],
): { gaps: Spike[]; latency: Spike[] } {
  const ends = [...presentEnds].sort((a, b) => a - b);
  const gaps: Spike[] = [];
  const waiting = new Map<number, { start: number; worst: number; inputs: number }>();
  for (const gesture of active) {
    const first = lowerBound(ends, gesture.start);
    const graceEnd = gesture.end + PRESENT_GRACE_MS * 1000;
    if (first >= ends.length || (ends[first] as number) > graceEnd) continue;
    // The inputs between each present and the next.
    const inputs = [...gesture.inputs].sort((a, b) => a - b);
    let next = 0;
    for (let index = first; next < inputs.length; index++) {
      const present = index < ends.length ? (ends[index] as number) : Number.POSITIVE_INFINITY;
      const between: number[] = [];
      while (next < inputs.length && (inputs[next] as number) < present)
        between.push(inputs[next++] as number);
      const gap = gapSpike(between, present);
      if (gap) gaps.push(gap);
      // Inputs at the very time of a present count as shown by it.
      while (next < inputs.length && (inputs[next] as number) === present) next++;
    }
    const horizon = gesture.end + LATENCY_HORIZON_MS * 1000;
    for (const input of gesture.inputs) {
      const index = lowerBound(ends, input);
      if (index >= ends.length) continue;
      const end = ends[index] as number;
      if (end > horizon) continue;
      const latency = (end - input) / 1000;
      if (latency < LAG_MS) continue;
      const entry = waiting.get(end);
      if (entry) {
        entry.start = Math.min(entry.start, input);
        entry.worst = Math.max(entry.worst, latency);
        entry.inputs++;
      } else waiting.set(end, { start: input, worst: latency, inputs: 1 });
    }
  }
  const latency = [...waiting].map(
    ([end, entry]): Spike => ({
      kind: "latency",
      thread: "engine",
      start: entry.start,
      end,
      durationMs: entry.worst,
      extra: entry.inputs,
    }),
  );
  return { gaps, latency };
}

/** Groups spikes whose windows overlap. */
export function groupSpikes(spikes: readonly Spike[]): Spike[][] {
  const sorted = [...spikes].sort((a, b) => a.start - b.start || b.end - a.end);
  const groups: Spike[][] = [];
  let end = Number.NEGATIVE_INFINITY;
  for (const spike of sorted) {
    const current = groups.at(-1);
    if (current !== undefined && spike.start <= end) {
      current.push(spike);
      end = Math.max(end, spike.end);
    } else {
      groups.push([spike]);
      end = spike.end;
    }
  }
  return groups;
}

/** What the user was doing during `[start, end]` (trace microseconds). */
export function describeActivity(
  inputs: readonly PerfInput[],
  drags: readonly Gesture[],
  toTrace: (ms: number) => number,
  start: number,
  end: number,
): string {
  const parts: string[] = [];
  for (const drag of drags) {
    if (drag.kind !== "drag" || drag.end < start || drag.start > end) continue;
    const where = drag.canvas ? "canvas" : "UI";
    const label =
      drag.end - drag.start < CLICK_MS * 1000 ? `click on ${where}` : `pointer drag on ${where}`;
    if (!parts.includes(label)) parts.push(label);
  }
  const near = (input: PerfInput, beforeMs: number) => {
    const time = toTrace(input.time);
    return time >= start - beforeMs * 1000 && time <= end;
  };
  if (inputs.some((input) => input.kind === "wheel" && near(input, 200))) {
    const canvas = inputs.some(
      (input) => input.kind === "wheel" && input.canvas && near(input, 200),
    );
    parts.push(canvas ? "wheel on canvas" : "wheel on UI");
  }
  if (inputs.some((input) => input.kind === "keydown" && near(input, 500))) parts.push("key press");
  if (
    parts.length === 0 &&
    inputs.some((input) => input.kind === "pointermove" && !input.drag && near(input, 200))
  ) {
    parts.push("pointer hover");
  }
  return parts.length > 0 ? parts.join(", ") : "no input (background work)";
}

/** The tool active at page time `time`: the last change at or before it. */
export function toolAt(tools: readonly ToolChange[], time: number): string | undefined {
  let current: string | undefined;
  for (const change of [...tools].sort((a, b) => a.time - b.time)) {
    if (change.time > time) break;
    current = change.tool;
  }
  return current;
}

export interface AnalyzeOptions {
  readonly resolve?: FrameResolver;
  /** How many of our functions and of the rest each table lists. */
  readonly ours?: number;
  readonly others?: number;
}

export function analyze(
  events: readonly TraceEvent[],
  app: AppRecording,
  options: AnalyzeOptions = {},
): LagAnalysis {
  const resolve = options.resolve ?? plainResolver;
  const threads = findThreads(events);
  const timed = events.filter((event) => event.ph !== "M" && event.ts > 0);
  const start = timed.reduce((min, event) => Math.min(min, event.ts), Number.POSITIVE_INFINITY);
  const end = timed.reduce((max, event) => Math.max(max, event.ts + (event.dur ?? 0)), 0);
  const clockEvent = events.find((event) => event.name === CLOCK_MARK && isUserTiming(event));
  const clockAligned = clockEvent !== undefined && app.clockTime !== undefined;
  const offset = clockAligned ? clockEvent.ts - (app.clockTime as number) * 1000 : 0;
  const toTrace = (ms: number) => offset + ms * 1000;
  const toPage = (us: number) => (us - offset) / 1000;
  const ready = app.readyTime === undefined ? (clockEvent?.ts ?? 0) : toTrace(app.readyTime);

  const spikes: Spike[] = [];
  const taskSummary: ThreadSummary[] = [];
  for (const name of ["main", "engine"] as const) {
    const tasks = threadTasks(events, threads[name]);
    const long = tasks.filter((task) => task.end - task.start >= LAG_MS * 1000);
    for (const task of long) {
      spikes.push({
        kind: "task",
        thread: name,
        start: task.start,
        end: task.end,
        durationMs: (task.end - task.start) / 1000,
      });
    }
    const durations = long.map((task) => (task.end - task.start) / 1000);
    taskSummary.push({
      thread: name,
      longTasks: long.length,
      longTaskMs: durations.reduce((sum, ms) => sum + ms, 0),
      longestTaskMs: Math.max(0, ...durations),
      blockingMs: durations.reduce((sum, ms) => sum + Math.max(0, ms - LAG_MS), 0),
    });
  }
  // Without tasks in the trace (it was lost), the page's own long task entries stand in.
  const mainSummary = taskSummary[0];
  if (
    clockAligned &&
    mainSummary !== undefined &&
    mainSummary.longTasks === 0 &&
    app.longTasks.length > 0
  ) {
    const durations: number[] = [];
    for (const task of app.longTasks) {
      if (task.duration < LAG_MS) continue;
      durations.push(task.duration);
      spikes.push({
        kind: "task",
        thread: "main",
        start: toTrace(task.start),
        end: toTrace(task.start + task.duration),
        durationMs: task.duration,
      });
    }
    taskSummary[0] = {
      thread: "main",
      longTasks: durations.length,
      longTaskMs: durations.reduce((sum, ms) => sum + ms, 0),
      longestTaskMs: Math.max(0, ...durations),
      blockingMs: durations.reduce((sum, ms) => sum + Math.max(0, ms - LAG_MS), 0),
    };
  }

  const all = clockAligned ? gestures(app.inputs, toTrace) : [];
  if (clockAligned) {
    for (const frame of app.longFrames) {
      if (frame.duration < LAG_MS) continue;
      spikes.push({
        kind: "frame",
        thread: "main",
        start: toTrace(frame.start),
        end: toTrace(frame.start + frame.duration),
        durationMs: frame.duration,
        extra: frame.blockingDuration ?? 0,
      });
    }
    const active = all.filter((gesture) => gesture.kind === "drag" || gesture.canvas);
    const { gaps, latency } = presentSpikes(
      app.presents.map((present) => toTrace(present.end)),
      active,
    );
    spikes.push(...gaps, ...latency);
  }

  const profiles = parseProfiles(events);
  const profilers = {
    main: new ThreadProfiler(
      "main",
      profiles.filter((p) => same(threads.main, p.thread)),
      resolve,
    ),
    engine: new ThreadProfiler(
      "engine",
      profiles.filter((p) => same(threads.engine, p.thread)),
      resolve,
    ),
  };
  const ours = options.ours ?? 6;
  const others = options.others ?? 4;

  const incidents = groupSpikes(spikes).map((group): Incident => {
    const from = Math.min(...group.map((spike) => spike.start));
    const to = Math.max(...group.map((spike) => spike.end));
    const attributions = (["main", "engine"] as const)
      .filter((name) => profilers[name].sampled)
      .map((name) => profilers[name].attribute([{ start: from, end: to }], ours, others));
    const tasks = group.filter((spike) => spike.kind === "task");
    const longestTask = [...tasks].sort((a, b) => b.durationMs - a.durationMs)[0];
    const busiest = [...attributions].sort((a, b) => b.busyMs - a.busyMs)[0];
    const thread: ThreadName =
      longestTask?.thread ??
      (group.some((spike) => spike.kind === "frame") ? "main" : (busiest?.thread ?? "main"));
    return {
      start: from,
      end: to,
      durationMs: Math.max(...group.map((spike) => spike.durationMs)),
      spikes: group,
      thread,
      activity: !clockAligned
        ? "unknown (no app data)"
        : from < ready
          ? "app loading"
          : describeActivity(app.inputs, all, toTrace, from, to),
      tool: clockAligned ? toolAt(app.tools, toPage(from)) : undefined,
      threads: attributions,
    };
  });

  const windows = incidents.map(({ start, end }) => ({ start, end }));
  const hot = (["main", "engine"] as const)
    .filter((name) => profilers[name].sampled)
    .map((name) => profilers[name].attribute(windows, ours + 4, others + 2));
  const spikeCounts: Record<SpikeKind, number> = {
    task: 0,
    frame: 0,
    "present-gap": 0,
    latency: 0,
  };
  for (const spike of spikes) spikeCounts[spike.kind]++;
  const sessionStart = Number.isFinite(start) ? start : 0;
  return {
    threads,
    start: sessionStart,
    end,
    sessionMs: Math.max(0, end - sessionStart) / 1000,
    clockAligned,
    profiled: { main: profilers.main.sampled, engine: profilers.engine.sampled },
    taskSummary,
    spikeCounts,
    incidents,
    hot,
  };
}
