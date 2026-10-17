import type { ScenarioMetrics } from "../src/perf/stats.ts";

/** One scenario's entry in the results file. */
export interface ScenarioResult {
  readonly id: string;
  readonly title: string;
  /** What the scenario actually did: zoom, stroke length, input counts and the like. */
  readonly setup: Readonly<Record<string, number | string | boolean>>;
  readonly metrics: ScenarioMetrics | null;
  /** True when the app did not settle within the cap; the metrics then cover up to the cap. */
  readonly timedOut: boolean;
  /** Set when the scenario could not run, with the reason. */
  readonly error?: string;
  /** What the app did that the numbers do not show, such as an edit that was not recorded. */
  readonly notes?: readonly string[];
}

/** The results file, `.perf/results/<engine>-<date>.json`. */
export interface BenchResults {
  readonly engine: string;
  readonly date: string;
  readonly browser: string;
  readonly backend: string | undefined;
  readonly adapter: unknown;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly devicePixelRatio: number;
  readonly scenarios: readonly ScenarioResult[];
}

/** The results file name for a run of `engine` at `date`, safe on every file system. */
export function resultsFileName(engine: string, date: Date): string {
  const stamp = date
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replaceAll(":", "-");
  return `${engine}-${stamp}.json`;
}

const ms = (value: number | null | undefined) =>
  value === null || value === undefined ? "-" : value.toFixed(value >= 100 ? 0 : 1);

/** The scenario metrics as a Markdown table, one row per scenario. */
export function formatTable(results: BenchResults): string {
  const header = [
    "ID",
    "Presents/s",
    "Interval p50 / p95 / max (ms)",
    "Latency p50 / p95 (ms)",
    "Longest task (ms)",
    "Long tasks total (ms)",
    "Settle (ms)",
    "Notes",
  ];
  const rows = results.scenarios.map((scenario) => {
    const m = scenario.metrics;
    if (m === null) return [scenario.id, scenario.error ?? "not run", "", "", "", "", "", ""];
    const settle = scenario.timedOut ? "> cap" : ms(m.settleMs);
    return [
      scenario.id,
      m.presentsPerSecond.toFixed(1),
      `${ms(m.presentInterval.p50)} / ${ms(m.presentInterval.p95)} / ${ms(m.presentInterval.max)}`,
      `${ms(m.inputLatency.p50)} / ${ms(m.inputLatency.p95)}`,
      ms(m.longestTaskMs),
      ms(m.totalLongTaskMs),
      settle,
      (scenario.notes ?? []).join("; "),
    ];
  });
  const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

/**
 * How many times better `next` is than `base`: a ratio where higher is better for rates and
 * lower is better for times. "-" when both are zero, "∞" when `next` removed the cost entirely.
 */
export function speedup(base: number, next: number, higherIsBetter: boolean): string {
  if (base === 0 && next === 0) return "-";
  const ratio = higherIsBetter ? next / base : base / next;
  if (!Number.isFinite(ratio)) return "∞";
  return `${ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(1)}×`;
}

/**
 * Two runs side by side: for each scenario and key metric, the
 * `base` value, the `next` value and the speedup.
 */
export function formatComparison(base: BenchResults, next: BenchResults): string {
  const metrics: {
    readonly name: string;
    readonly value: (m: ScenarioMetrics) => number | null;
    readonly higherIsBetter: boolean;
  }[] = [
    { name: "Presents/s", value: (m) => m.presentsPerSecond, higherIsBetter: true },
    { name: "Interval p95 (ms)", value: (m) => m.presentInterval.p95, higherIsBetter: false },
    { name: "Latency p50 (ms)", value: (m) => m.inputLatency.p50, higherIsBetter: false },
    { name: "Latency p95 (ms)", value: (m) => m.inputLatency.p95, higherIsBetter: false },
    { name: "Longest task (ms)", value: (m) => m.longestTaskMs, higherIsBetter: false },
    { name: "Long tasks total (ms)", value: (m) => m.totalLongTaskMs, higherIsBetter: false },
    { name: "Settle (ms)", value: (m) => m.settleMs, higherIsBetter: false },
  ];
  const header = [
    "ID",
    ...metrics.map((metric) => `${metric.name} ${base.engine} → ${next.engine}`),
  ];
  const rows = base.scenarios.map((scenario) => {
    const after = next.scenarios.find((candidate) => candidate.id === scenario.id);
    const a = scenario.metrics;
    const b = after?.metrics ?? null;
    if (a === null || b === null) return [scenario.id, ...metrics.map(() => "not run")];
    return [
      scenario.id,
      ...metrics.map(({ value, higherIsBetter }) => {
        const before = value(a);
        const now = value(b);
        if (before === null || now === null) return "-";
        const show = (v: number) => (higherIsBetter ? v.toFixed(1) : ms(v));
        return `${show(before)} → ${show(now)} (${speedup(before, now, higherIsBetter)})`;
      }),
    ];
  });
  const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}
