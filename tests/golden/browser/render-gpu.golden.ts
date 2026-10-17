import { expect, test } from "@playwright/test";
import { GPU_TOLERANCE } from "../src/compare";
import { CLOUDS_CASES, JULIA_CASES, MANDELBROT_CASES, TURBULENCE_CASES } from "../src/render-cases";

test.describe("Clouds: WGSL against the Rust reference (±1)", () => {
  for (const kase of CLOUDS_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runCloudsCase(id), kase.id);
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

test.describe("Turbulence: WGSL against the Rust reference (±1)", () => {
  for (const kase of TURBULENCE_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runTurbulenceCase(id), kase.id);
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

test.describe("Julia: WGSL against the Rust reference (±1)", () => {
  for (const kase of JULIA_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runJuliaCase(id), kase.id);
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

test.describe("Mandelbrot: WGSL against the Rust reference (±1)", () => {
  for (const kase of MANDELBROT_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runMandelbrotCase(id), kase.id);
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
