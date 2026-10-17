import { expect, test } from "@playwright/test";
import {
  ADD_NOISE_CASES,
  DISTORT_CASES,
  FRAGMENT_CASES,
  FROST_CASES,
  MEDIAN_CASES,
  MORPHOLOGY_CASES,
  MOTION_CASES,
  NOISE_CASES,
  PIXELATE_CASES,
  RADIAL_CASES,
  REDUCE_NOISE_CASES,
  SURFACE_CASES,
  TILED_CASES,
  WARP_CASES,
  ZOOM_CASES,
} from "../src/cases";
import { GPU_TOLERANCE } from "../src/compare";

test.describe("Distortion engine: WGSL against the Rust reference (±1)", () => {
  for (const kase of DISTORT_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runDistortCase(id), kase.id);
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

test.describe("Warp maps (Bulge, Twist, Polar Inversion, Tile Reflection, Crystalize, Dents): WGSL against the Rust reference (±1)", () => {
  for (const kase of WARP_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runWarpCase(id), kase.id);
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

test.describe("Frosted Glass: WGSL against the Rust reference (±1)", () => {
  for (const kase of FROST_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runFrostCase(id), kase.id);
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

test.describe("Pixelate: WGSL against the Rust reference (±1)", () => {
  for (const kase of PIXELATE_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runPixelateCase(id), kase.id);
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

test.describe("Morphology: WGSL against the Rust reference (±1)", () => {
  for (const kase of MORPHOLOGY_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runMorphologyCase(id), kase.id);
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

test.describe("Fragment Blur: WGSL against the Rust reference (±1)", () => {
  for (const kase of FRAGMENT_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runFragmentCase(id), kase.id);
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

test.describe("Radial Blur: WGSL against the Rust reference (±1)", () => {
  for (const kase of RADIAL_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runRadialCase(id), kase.id);
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

test.describe("Zoom Blur: WGSL against the Rust reference (±1)", () => {
  for (const kase of ZOOM_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runZoomCase(id), kase.id);
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

test.describe("Median Blur: WGSL against the Rust reference (±1)", () => {
  for (const kase of MEDIAN_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runMedianCase(id), kase.id);
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

test.describe("Surface Blur: WGSL against the Rust reference (±1)", () => {
  for (const kase of SURFACE_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runSurfaceCase(id), kase.id);
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

test.describe("Median and Surface Blur tiles: GPU over several dispatches against the Rust reference (±1)", () => {
  for (const kase of TILED_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runTiledCase(id), kase.id);
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

test.describe("Motion Blur: WGSL against the Rust reference (±1)", () => {
  for (const kase of MOTION_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runMotionCase(id), kase.id);
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

test.describe("Add Noise: WGSL against the Rust reference (within 1)", () => {
  for (const kase of ADD_NOISE_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runAddNoiseCase(id), kase.id);
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

test.describe("Reduce Noise: WGSL against the Rust reference (within 1)", () => {
  for (const kase of REDUCE_NOISE_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runReduceNoiseCase(id), kase.id);
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
test.describe("Pixel noise: WGSL against the Rust reference (±1)", () => {
  for (const kase of NOISE_CASES) {
    test(kase.id, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser/index.html");

      const result = await page.evaluate((id) => window.runNoiseCase(id), kase.id);
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
