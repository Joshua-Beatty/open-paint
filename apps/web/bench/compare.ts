/// <reference types="node" />
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resultsKey } from "./browser.ts";
import { type BenchResults, formatComparison } from "./report.ts";
import { RESULTS_DIR } from "./store.ts";

/**
 * `pnpm bench:compare`: runs every scenario on engine v1, then on engine v2, and prints and saves
 * the side-by-side table. `--no-run` compares the newest saved results of
 * each engine without running anything. Extra arguments go to Playwright (e.g. `-g B3`).
 */
const ENGINES = ["v1", "v2"] as const;
const args = process.argv.slice(2);
const run = !args.includes("--no-run");
const extra = args.filter((arg) => arg !== "--no-run");

if (run) {
  for (const engine of ENGINES) {
    const result = spawnSync(
      "pnpm",
      ["exec", "playwright", "test", "-c", "playwright.bench.config.ts", "scenarios", ...extra],
      { stdio: "inherit", shell: true, env: { ...process.env, OPENPAINT_ENGINE: engine } },
    );
    if (result.status !== 0) console.warn(`The ${engine} run exited with ${result.status}.`);
  }
}

/** The newest results file of an engine. Names sort by date, as they hold the UTC time. */
function newest(engine: string): BenchResults {
  const name = readdirSync(RESULTS_DIR)
    .filter(
      (file) =>
        file.startsWith(`${engine}-`) &&
        /^\d/.test(file.slice(engine.length + 1)) &&
        file.endsWith(".json"),
    )
    .sort()
    .at(-1);
  if (name === undefined) throw new Error(`No ${engine} results in ${RESULTS_DIR}.`);
  return JSON.parse(readFileSync(`${RESULTS_DIR}${name}`, "utf8")) as BenchResults;
}

const [base, next] = ENGINES.map((engine) => newest(resultsKey(engine))) as [
  BenchResults,
  BenchResults,
];
const table = formatComparison(base, next);
const path = `${RESULTS_DIR}compare-${next.date.replace(/\.\d+Z$/, "Z").replaceAll(":", "-")}.md`;
writeFileSync(
  path,
  `# ${base.engine} (${base.date}) vs ${next.engine} (${next.date})\n\n${table}\n`,
);
console.log(`\n${table}\n\nSaved ${path}\n`);
