import { expect, test } from "@playwright/test";
import { BOKEH_CASES } from "../src/cases";
import { GPU_TOLERANCE } from "../src/compare";

test.describe("Bokeh Blur: WGSL against the Rust reference (±1)", () => {
  for (const kase of BOKEH_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runBokehCase(id), kase.id);
      if (result === null) {
        test.skip(true, "No WebGPU adapter in this browser; GPU golden checks are skipped.");
        return;
      }
      expect(errors).toEqual([]);
      expect(
        result.maxDifference,
        `${kase.id}: ${result.differingChannels} channels differ`,
      ).toBeLessThanOrEqual(GPU_TOLERANCE);
    });
  }
});
