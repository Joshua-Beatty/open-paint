/// <reference types="node" />
import { mkdirSync, writeFileSync } from "node:fs";
import { resultsKey } from "./browser.ts";
import { ENGINE } from "./harness.ts";
import { type BenchResults, formatTable, resultsFileName, type ScenarioResult } from "./report.ts";
import { loadScenarios, RESULTS_DIR, SCENARIO_IDS } from "./store.ts";

/**
 * Gathers the scenario results of this run into `.perf/results/<engine>-<date>.json` and
 * prints them as a table. Scenarios that were not run (filtered out) are left out.
 */
export default function teardown(): void {
  const saved = loadScenarios();
  if (saved.length === 0) return;
  const order = (id: string) => SCENARIO_IDS.indexOf(id as (typeof SCENARIO_IDS)[number]);
  const scenarios: ScenarioResult[] = saved
    .map((entry) => entry.result)
    .sort((a, b) => order(a.id) - order(b.id));
  const first = saved.find((entry) => entry.result.metrics !== null) ?? saved[0];
  const date = new Date();
  const results: BenchResults = {
    engine: ENGINE,
    date: date.toISOString(),
    browser: first?.browser ?? "",
    backend: first?.backend,
    adapter: first?.adapter,
    viewport: { width: 1440, height: 900 },
    devicePixelRatio: first?.devicePixelRatio ?? 1,
    ranEngine: first?.engine,
    crossOriginIsolated: first?.crossOriginIsolated,
    userAgent: first?.userAgent,
    scenarios,
  };
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = `${RESULTS_DIR}${resultsFileName(resultsKey(ENGINE), date)}`;
  writeFileSync(path, `${JSON.stringify(results, null, 2)}\n`);
  const distinct = (values: readonly unknown[]) =>
    [...new Set(values.map((value) => String(value ?? "unknown")))].join(", ");
  const backends = distinct(saved.map((entry) => entry.backend));
  const engines = distinct(saved.map((entry) => entry.engine));
  const isolated = distinct(saved.map((entry) => entry.crossOriginIsolated));
  console.log(
    `\nOpenPaint bench, engine ${ENGINE} (ran ${engines}), backend ${backends}, crossOriginIsolated ${isolated}, ${results.browser}\n\n${formatTable(results)}\n\nSaved ${path}\n`,
  );
}
