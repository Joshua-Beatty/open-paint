import type { PerfInput } from "../src/perf/stats.ts";
import {
  type AppRecording,
  type CallFrame,
  CLOCK_MARK,
  PRESENT_MEASURE,
  type ThreadId,
  type TraceEvent,
} from "./analyze.ts";

/**
 * Builders for small synthetic traces in the shape Chrome writes them, for the analysis tests.
 * Trace times are microseconds; the page clock is lined up so that page time 0 is trace time
 * `PAGE_ORIGIN`.
 */

export const MAIN: ThreadId = { pid: 1, tid: 10 };
export const ENGINE: ThreadId = { pid: 1, tid: 20 };
const SAMPLER_TID = 99;

/** Trace time of page time 0. */
export const PAGE_ORIGIN = 5_000_000;

/** Trace microseconds of page time `ms`. */
export const us = (ms: number) => PAGE_ORIGIN + ms * 1000;

export function threadName(thread: ThreadId, name: string): TraceEvent {
  return { name: "thread_name", cat: "__metadata", ph: "M", ts: 0, ...thread, args: { name } };
}

/** The recorder's clock mark at page time `ms`. */
export function clockMark(ms: number): TraceEvent {
  return { name: CLOCK_MARK, cat: "blink.user_timing", ph: "I", ts: us(ms), ...MAIN };
}

export function presentMeasure(ms: number): TraceEvent {
  return { name: PRESENT_MEASURE, cat: "blink.user_timing", ph: "b", ts: us(ms), ...ENGINE };
}

export function task(thread: ThreadId, startMs: number, durationMs: number): TraceEvent {
  return {
    name: "RunTask",
    cat: "disabled-by-default-devtools.timeline",
    ph: "X",
    ts: us(startMs),
    dur: durationMs * 1000,
    ...thread,
  };
}

export interface ProfileFrame extends CallFrame {
  /** The calling frame's function name, or undefined for a root child. */
  readonly parent?: string;
}

/**
 * A CPU profile of `thread` from page time `startMs`: one sample every `intervalMs`, each naming
 * its leaf function. `frames` defines the functions and their callers. The nodes and samples are
 * split over two chunks, as Chrome does.
 */
export function profile(
  thread: ThreadId,
  id: string,
  startMs: number,
  intervalMs: number,
  frames: Record<string, ProfileFrame>,
  samples: readonly string[],
): TraceEvent[] {
  const ids = new Map<string, number>([["(root)", 1]]);
  const nodes: { id: number; parent?: number; callFrame: CallFrame }[] = [
    { id: 1, callFrame: { functionName: "(root)" } },
  ];
  const nodeOf = (name: string): number => {
    const known = ids.get(name);
    if (known !== undefined) return known;
    const frame = frames[name] ?? { functionName: name };
    const parent = nodeOf(frame.parent ?? "(root)");
    const node = nodes.length + 1;
    ids.set(name, node);
    const { parent: _, ...callFrame } = frame;
    nodes.push({ id: node, parent, callFrame });
    return node;
  };
  const sampleIds = samples.map(nodeOf);
  const half = Math.ceil(sampleIds.length / 2);
  const deltas = sampleIds.map((_, index) => (index === 0 ? 0 : intervalMs * 1000));
  const chunk = (from: number, to: number, withNodes: typeof nodes): TraceEvent => ({
    name: "ProfileChunk",
    cat: "disabled-by-default-v8.cpu_profiler",
    ph: "P",
    ts: us(startMs),
    pid: thread.pid,
    tid: SAMPLER_TID,
    id,
    args: {
      data: {
        cpuProfile: { nodes: withNodes, samples: sampleIds.slice(from, to) },
        timeDeltas: deltas.slice(from, to),
      },
    },
  });
  const nodeSplit = Math.ceil(nodes.length / 2);
  return [
    {
      name: "Profile",
      cat: "disabled-by-default-v8.cpu_profiler",
      ph: "P",
      ts: us(startMs),
      ...thread,
      id,
      args: { data: { startTime: us(startMs) } },
    },
    chunk(0, half, nodes.slice(0, nodeSplit)),
    chunk(half, sampleIds.length, nodes.slice(nodeSplit)),
  ];
}

export function emptyApp(overrides: Partial<AppRecording> = {}): AppRecording {
  return {
    presents: [],
    inputs: [],
    longTasks: [],
    longFrames: [],
    tools: [],
    clockTime: 0,
    ...overrides,
  };
}

/** A drag on the canvas: down at `fromMs`, a move every `stepMs`, up at `toMs`. */
export function drag(fromMs: number, toMs: number, stepMs = 8, canvas = true): PerfInput[] {
  const inputs: PerfInput[] = [{ kind: "pointerdown", time: fromMs, canvas, drag: true }];
  for (let time = fromMs + stepMs; time < toMs; time += stepMs) {
    inputs.push({ kind: "pointermove", time, canvas, drag: true });
  }
  inputs.push({ kind: "pointerup", time: toMs, canvas, drag: true });
  return inputs;
}

/** Presents every `stepMs` from `fromMs` to `toMs` (page time), 2 ms of work each. */
export function presents(fromMs: number, toMs: number, stepMs = 16) {
  const list: { start: number; end: number }[] = [];
  for (let time = fromMs; time <= toMs; time += stepMs) list.push({ start: time - 2, end: time });
  return list;
}
