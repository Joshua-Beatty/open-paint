/// <reference types="node" />
import { readFileSync } from "node:fs";

/**
 * Summarizes a Firefox profile that `BENCH_PROFILE` saved for `BENCH_BROWSER=firefox-desktop`
 * (the raw Gecko format written at shutdown). The window runs from each `bench:gesture-start`
 * user timing mark to the next `bench:settled` mark (the app idle after the gesture), or to
 * `bench:gesture-end` with `--gesture`. For each thread that used CPU in it, it prints the CPU time
 * and the named frames (JS functions and Gecko labels; native frames are not symbolicated) with the
 * most self time (nearest named frame of each sample) and inclusive time.
 *
 *   node bench/gecko-profile.ts <profile.json> [--top=20] [--thread=<name part>] [--gesture]
 */

interface Table {
  readonly schema: Record<string, number>;
  readonly data: readonly (readonly unknown[])[];
}

interface GeckoThread {
  readonly name: string;
  readonly processType?: string;
  readonly pid?: number | string;
  readonly tid?: number | string;
  readonly samples: Table;
  readonly markers: Table;
  readonly stackTable: Table;
  readonly frameTable: Table;
  readonly stringTable: readonly string[];
}

interface GeckoProfile {
  readonly meta: {
    readonly startTime: number;
    readonly interval: number;
    readonly sampleUnits?: { readonly threadCPUDelta?: string };
  };
  readonly threads: readonly GeckoThread[];
  readonly processes?: readonly GeckoProfile[];
}

interface FlatThread {
  readonly thread: GeckoThread;
  /** Added to the thread's times to put them on the parent process's clock. */
  readonly offset: number;
  readonly interval: number;
  /** Milliseconds per `threadCPUDelta` unit. */
  readonly cpuScale: number;
}

function cpuScale(unit: string | undefined): number {
  if (unit === "ns") return 1e-6;
  if (unit === "µs") return 1e-3;
  return 0;
}

function flatten(profile: GeckoProfile, base: number, out: FlatThread[]): void {
  const offset = profile.meta.startTime - base;
  const scale = cpuScale(profile.meta.sampleUnits?.threadCPUDelta);
  for (const thread of profile.threads) {
    out.push({ thread, offset, interval: profile.meta.interval, cpuScale: scale });
  }
  for (const child of profile.processes ?? []) flatten(child, base, out);
}

/** User timing marks named `bench:*` from every thread, on the parent clock, by name. */
function benchMarks(threads: readonly FlatThread[]): Map<string, number[]> {
  const marks = new Map<string, number[]>();
  for (const { thread, offset } of threads) {
    const { schema, data } = thread.markers;
    for (const marker of data) {
      const payload = marker[schema.data ?? 5] as { type?: string; name?: string } | null;
      if (payload?.type !== "UserTiming" || !payload.name?.startsWith("bench:")) continue;
      const time = (marker[schema.startTime ?? 1] as number) + offset;
      marks.set(payload.name, [...(marks.get(payload.name) ?? []), time]);
    }
  }
  for (const times of marks.values()) times.sort((a, b) => a - b);
  return marks;
}

const NATIVE = /^0x[0-9a-f]+$/i;

function frameName(thread: GeckoThread, frame: number): string {
  const { schema, data } = thread.frameTable;
  const row = data[frame];
  if (row === undefined) return "?";
  const location = thread.stringTable[row[schema.location ?? 0] as number] ?? "?";
  return location.replace(/\(https?:\/\/[^)]*\/([^/)]+)\)/, "($1)");
}

function summarize(flat: FlatThread, windows: readonly [number, number][], top: number): string {
  const { thread, offset, interval } = flat;
  const { schema, data } = thread.samples;
  const stackIndex = schema.stack ?? 0;
  const timeIndex = schema.time ?? 1;
  const cpuIndex = schema.threadCPUDelta;
  const prefixIndex = thread.stackTable.schema.prefix ?? 0;
  const frameIndex = thread.stackTable.schema.frame ?? 1;
  const self = new Map<string, number>();
  const inclusive = new Map<string, number>();
  let cpu = 0;
  for (const sample of data) {
    const time = (sample[timeIndex] as number) + offset;
    if (!windows.some(([start, end]) => time >= start && time <= end)) continue;
    // CPU used since the previous sample; without the cpu feature, one interval per sample.
    const delta =
      cpuIndex === undefined || flat.cpuScale === 0
        ? interval
        : ((sample[cpuIndex] as number | null) ?? 0) * flat.cpuScale;
    if (delta <= 0) continue;
    cpu += delta;
    let stack = sample[stackIndex] as number | null;
    const names: string[] = [];
    while (stack !== null && stack !== undefined) {
      const row = thread.stackTable.data[stack];
      if (row === undefined) break;
      names.push(frameName(thread, row[frameIndex] as number));
      stack = row[prefixIndex] as number | null;
    }
    const named = names.filter((name) => !NATIVE.test(name));
    const leaf = named[0] ?? "(native)";
    self.set(leaf, (self.get(leaf) ?? 0) + delta);
    for (const name of new Set(named)) inclusive.set(name, (inclusive.get(name) ?? 0) + delta);
  }
  if (cpu < 5) return "";
  const spans = longSpans(flat, windows, top);
  const list = (map: Map<string, number>) =>
    [...map]
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([name, ms]) => `    ${ms.toFixed(0).padStart(7)} ms  ${name.slice(0, 170)}`)
      .join("\n");
  return [
    `${thread.name} (${thread.processType ?? "?"} pid ${thread.pid ?? "?"} tid ${thread.tid ?? "?"}): ${cpu.toFixed(0)} ms CPU`,
    "  self (nearest named frame):",
    list(self),
    "  inclusive:",
    list(inclusive),
    ...spans,
  ].join("\n");
}

/** With `--long=<ms>`: the thread's busy spans of at least that long, each with its top frames. */
function longSpans(flat: FlatThread, windows: readonly [number, number][], top: number): string[] {
  const threshold = Number(option("long") ?? Number.NaN);
  if (!Number.isFinite(threshold)) return [];
  const { thread, offset, interval } = flat;
  const { schema, data } = thread.samples;
  const cpuIndex = schema.threadCPUDelta;
  const timeIndex = schema.time ?? 1;
  const stackIndex = schema.stack ?? 0;
  const prefixIndex = thread.stackTable.schema.prefix ?? 0;
  const frameIndex = thread.stackTable.schema.frame ?? 1;
  const out: string[] = [];
  let span: { start: number; end: number; frames: Map<string, number> } | undefined;
  let previous: number | undefined;
  const close = () => {
    if (span !== undefined && span.end - span.start >= threshold) {
      const frames = [...span.frames]
        .sort((a, b) => b[1] - a[1])
        .slice(0, Math.min(top, 12))
        .map(([name, count]) => `      ${String(count).padStart(5)}  ${name.slice(0, 150)}`)
        .join("\n");
      out.push(
        `  busy ${(span.end - span.start).toFixed(0)} ms at ${span.start.toFixed(0)} ms:\n${frames}`,
      );
    }
    span = undefined;
  };
  for (const sample of data) {
    const time = (sample[timeIndex] as number) + offset;
    if (!windows.some(([start, end]) => time >= start && time <= end)) continue;
    const delta =
      cpuIndex === undefined || flat.cpuScale === 0
        ? interval
        : ((sample[cpuIndex] as number | null) ?? 0) * flat.cpuScale;
    // Busy: the thread ran for most of the time since the previous sample.
    const gap = previous === undefined ? interval : time - previous;
    previous = time;
    if (delta < gap * 0.5) {
      close();
      continue;
    }
    span ??= { start: time, end: time, frames: new Map() };
    span.end = time;
    let stack = sample[stackIndex] as number | null;
    const names = new Set<string>();
    while (stack !== null && stack !== undefined) {
      const row = thread.stackTable.data[stack];
      if (row === undefined) break;
      const name = frameName(thread, row[frameIndex] as number);
      if (!NATIVE.test(name)) names.add(name);
      stack = row[prefixIndex] as number | null;
    }
    for (const name of names) span.frames.set(name, (span.frames.get(name) ?? 0) + 1);
  }
  close();
  return out;
}

const args = process.argv.slice(2);
const path = args.find((arg) => !arg.startsWith("--"));
const option = (name: string) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (path === undefined) {
  console.error(
    "usage: node bench/gecko-profile.ts <profile.json> [--top=20] [--thread=<name>] [--gesture]",
  );
  process.exit(1);
}
const profile = JSON.parse(readFileSync(path, "utf8")) as GeckoProfile;
const threads: FlatThread[] = [];
flatten(profile, profile.meta.startTime, threads);
const marks = benchMarks(threads);
const ends = marks.get(args.includes("--gesture") ? "bench:gesture-end" : "bench:settled") ?? [];
const windows: [number, number][] = (marks.get("bench:gesture-start") ?? []).map((start) => [
  start,
  ends.find((end) => end > start) ?? Number.POSITIVE_INFINITY,
]);
console.log(
  `${windows.length} window(s): ${windows.map(([a, b]) => `${a.toFixed(0)}-${b.toFixed(0)} ms`).join(", ")}`,
);
const ranges: [number, number][] =
  windows.length > 0 ? windows : [[Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]];
const top = Number(option("top") ?? 20);
const filter = option("thread");
const summaries = threads
  .filter((flat) => filter === undefined || flat.thread.name.includes(filter))
  .map((flat) => summarize(flat, ranges, top))
  .filter((text) => text !== "");
console.log(`\n${summaries.join("\n\n")}`);
