import { PERF_FLAGS } from "./flags";

/** The prefix of every user timing measure the app records, so traces can find them. */
export const MEASURE_PREFIX = "openpaint:";

/** Receives every measured span while the perf harness records stages (`PerfMonitor`). */
export const measuredStages: { record?: (name: string, start: number, end: number) => void } = {};

/**
 * Runs `run` and, with `?perf=1`, records it as the user timing measure `openpaint:<name>`. The
 * measure shows up in performance traces (`pnpm lag`, DevTools). It is cleared at once, so a long
 * session does not fill the performance timeline. Without `?perf=1` it costs one flag check.
 */
export function measured<T>(name: string, run: () => T, enabled = PERF_FLAGS.perf): T {
  if (!enabled) return run();
  const start = performance.now();
  try {
    return run();
  } finally {
    const end = performance.now();
    const measure = `${MEASURE_PREFIX}${name}`;
    performance.measure(measure, { start, end });
    performance.clearMeasures(measure);
    measuredStages.record?.(name, start, end);
  }
}
