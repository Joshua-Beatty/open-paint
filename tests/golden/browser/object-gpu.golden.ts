import { expect, test } from "@playwright/test";
import { ALIGN_OBJECT_CASES, DROP_SHADOW_CASES, FLIP_OBJECT_CASES } from "../src/cases";
import { GPU_TOLERANCE } from "../src/compare";

test.describe("Drop Shadow: WGSL against the Rust reference (±1)", () => {
  for (const kase of DROP_SHADOW_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runDropShadowCase(id), kase.id);
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

test.describe("Flip Horizontal and Flip Vertical: WGSL against the Rust reference (exact)", () => {
  for (const kase of FLIP_OBJECT_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runFlipObjectCase(id), kase.id);
      if (result === null) {
        test.skip(true, "No WebGPU adapter in this browser; GPU golden checks are skipped.");
        return;
      }
      expect(errors).toEqual([]);
      expect(result.maxDifference, `${kase.id}: ${result.differingChannels} channels differ`).toBe(
        0,
      );
    });
  }
});

test.describe("Align Object: WGSL against the Rust reference (exact)", () => {
  for (const kase of ALIGN_OBJECT_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runAlignObjectCase(id), kase.id);
      if (result === null) {
        test.skip(true, "No WebGPU adapter in this browser; GPU golden checks are skipped.");
        return;
      }
      expect(errors).toEqual([]);
      expect(result.maxDifference, `${kase.id}: ${result.differingChannels} channels differ`).toBe(
        0,
      );
    });
  }
});
