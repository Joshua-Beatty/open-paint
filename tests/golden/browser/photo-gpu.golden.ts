import { expect, test } from "@playwright/test";
import {
  GLOW_CASES,
  ROTATE_ZOOM_CASES,
  SHARPEN_CASES,
  SOFTEN_CASES,
  STRAIGHTEN_CASES,
  VIGNETTE_CASES,
} from "../src/cases";
import { GPU_TOLERANCE } from "../src/compare";

test.describe("Glow: WGSL against the Rust reference (±1)", () => {
  for (const kase of GLOW_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runGlowCase(id), kase.id);
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

test.describe("Soften Portrait: WGSL against the Rust reference (±1)", () => {
  for (const kase of SOFTEN_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runSoftenCase(id), kase.id);
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

test.describe("Straighten: WGSL against the Rust reference (±1)", () => {
  for (const kase of STRAIGHTEN_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runStraightenCase(id), kase.id);
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

test.describe("Vignette: WGSL against the Rust reference (±1)", () => {
  for (const kase of VIGNETTE_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runVignetteCase(id), kase.id);
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

test.describe("Rotate / Zoom: WGSL against the Rust reference (±1)", () => {
  for (const kase of ROTATE_ZOOM_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runRotateZoomCase(id), kase.id);
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

test.describe("Sharpen: WGSL against the Rust reference (±1)", () => {
  for (const kase of SHARPEN_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runSharpenCase(id), kase.id);
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
