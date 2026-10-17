/// <reference types="node" />
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ScenarioResult } from "./report.ts";

/** One scenario's result and the environment it ran in, saved by the test that ran it. */
export interface SavedScenario {
  readonly result: ScenarioResult;
  readonly browser: string;
  readonly backend: string | undefined;
  readonly adapter: unknown;
  readonly devicePixelRatio: number;
  /** The engine that ran (`v1` when `?engine=v2` fell back), when the page reported it. */
  readonly engine?: string | undefined;
  readonly crossOriginIsolated?: boolean | undefined;
  readonly hardwareConcurrency?: number | undefined;
  readonly userAgent?: string | undefined;
}

/** The benchmark scenarios, in report order. */
export const SCENARIO_IDS = [
  "B1",
  "B2",
  "B3",
  "B4",
  "B5",
  "B6",
  "B7",
  "B8",
  "B9a",
  "B9b",
  "B9c",
  "B10a",
  "B10b",
  "B11",
  "B12a",
  "B12b",
  "B13a",
  "B13b",
  "B14",
  "B15",
  "B16",
  "B17",
  "B18",
  "B19a",
  "B19b",
  "B20a",
  "B20b",
  "B21",
  "B22",
  "B23a",
  "B23b",
] as const;

/** Inside Playwright's output folder, which is emptied at the start of every run. */
const SCENARIO_DIR = fileURLToPath(new URL("../test-results/bench-scenarios/", import.meta.url));

/** The repository's gitignored `.perf/results/` folder. */
export const RESULTS_DIR = fileURLToPath(new URL("../../../.perf/results/", import.meta.url));

export function saveScenario(saved: SavedScenario): void {
  mkdirSync(SCENARIO_DIR, { recursive: true });
  writeFileSync(`${SCENARIO_DIR}${saved.result.id}.json`, JSON.stringify(saved, null, 2));
}

export function loadScenarios(): SavedScenario[] {
  let names: string[];
  try {
    names = readdirSync(SCENARIO_DIR);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(`${SCENARIO_DIR}${name}`, "utf8")) as SavedScenario);
}
