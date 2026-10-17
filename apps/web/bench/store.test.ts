// @vitest-environment node
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RESULTS_DIR } from "./store.ts";

describe("RESULTS_DIR", () => {
  it("is the gitignored .perf/results folder at the repository root", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    expect(join(RESULTS_DIR)).toBe(join(root, ".perf", "results/"));
  });
});
