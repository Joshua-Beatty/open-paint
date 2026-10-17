import { PERF_FLAGS } from "./flags";

/** The prefix of every user timing measure the app records, so traces can find them. */
export const MEASURE_PREFIX = "openpaint:";

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
    const measure = `${MEASURE_PREFIX}${name}`;
    performance.measure(measure, { start, end: performance.now() });
    performance.clearMeasures(measure);
  }
}
