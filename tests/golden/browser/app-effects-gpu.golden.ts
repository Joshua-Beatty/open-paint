import { GPU_EFFECT_IDS } from "@openpaint/engine";
import { expect, test } from "@playwright/test";
import { GPU_TOLERANCE } from "../src/compare";

/**
 * Every effect the app runs on the GPU, as the app runs it: the binding's default parameters, cloned
 * as they cross to the engine worker, through the worker's effect queue, against the binding's own
 * Rust reference (WEB-GPU-03).
 */
const CASES = [
  ...GPU_EFFECT_IDS,
  "align-object@selection",
  "autoLevel@selection",
  "flip-horizontal@selection",
  "flip-vertical@partial-selection",
  "red-eye@reds",
  "red-eye@reds-selection",
];

test.describe("App GPU effects: the engine's effect queue against the Rust reference (±1)", () => {
  for (const id of CASES) {
    test(id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((caseId) => window.runAppEffectCase(caseId), id);
      if (result === null) {
        test.skip(true, "No WebGPU adapter in this browser; GPU golden checks are skipped.");
        return;
      }
      expect(errors).toEqual([]);
      expect(
        result.maxDifference,
        `${id}: ${result.differingChannels} channels differ`,
      ).toBeLessThanOrEqual(GPU_TOLERANCE);
    });
  }
});
