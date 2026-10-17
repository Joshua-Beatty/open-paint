// Regenerates the golden fixtures from the Rust reference by running the update test in Vitest.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const vitest = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const result = spawnSync(process.execPath, [vitest, "run", "update-goldens"], {
  stdio: "inherit",
  env: { ...process.env, GOLDEN_UPDATE: "1" },
});

process.exitCode = result.status ?? 1;
