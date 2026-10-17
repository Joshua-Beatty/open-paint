import { expect, test } from "@playwright/test";
import { GPU_TOLERANCE } from "../src/compare";

const SAMPLINGS = ["nearest", "linear", "multisample", "anisotropic", "cubic"] as const;
const CASES = SAMPLINGS.flatMap((sampling) =>
  ["linear", "companded"].flatMap((light) =>
    ["rotate", "shrink", "grow"].map((kind) => `${sampling}-${light}-${kind}`),
  ),
);

test.describe("Move Selected Pixels resampling: WGSL against transform_rgba8 (±1)", () => {
  for (const id of CASES) {
    test(id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((caseId) => window.runTransformCase(caseId), id);
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
