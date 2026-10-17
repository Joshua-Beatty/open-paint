import { expect, test } from "@playwright/test";
import { GPU_TOLERANCE } from "../src/compare";

/** The ids of `FLOAT_CASES` in `packages/engine/src/gpu-float-checks.ts`. */
const SAMPLINGS = ["nearest", "linear", "multisample", "anisotropic", "cubic"];
const CASES = [
  ...SAMPLINGS.flatMap((sampling) =>
    ["linear", "companded"].map((light) => `all-rotate-${sampling}-${light}`),
  ),
  ...["ellipse", "lasso"].flatMap((shape) =>
    ["rotate", "shrink", "grow", "shift", "nudge", "stamp"].map((move) => `${shape}-${move}`),
  ),
  "all-grow-cubic",
  "all-stamp-linear",
];

test.describe("Move Selected Pixels floating preview: WGSL against the recorded reference (±1)", () => {
  for (const id of CASES) {
    test(id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        // GPU validation errors are logged (main.ts); a missing favicon is not one of them.
        if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
          errors.push(message.text());
        }
      });
      await page.goto("/browser/index.html");
      const result = await page.evaluate((caseId) => window.runFloatCase(caseId), id);
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
