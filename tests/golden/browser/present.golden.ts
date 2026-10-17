import { expect, type Page, test } from "@playwright/test";
import { GPU_TOLERANCE } from "../src/compare";

async function check(page: Page, id: "cpu" | "gpu") {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
      errors.push(message.text());
    }
  });
  await page.goto("/browser/index.html");
  const result = await page.evaluate((kase) => window.runPresentEdgeCase(kase), id);
  if (result === null) {
    test.skip(true, "No WebGPU adapter in this browser; GPU golden checks are skipped.");
    return;
  }
  expect(errors).toEqual([]);
  expect(
    result.maxDifference,
    `${id}: ${result.differingChannels} channels differ from the image's color`,
  ).toBeLessThanOrEqual(GPU_TOLERANCE);
}

test.describe("canvas presentation: the image covers the checkerboard to its edge (UI-VIEW-02)", () => {
  test("Canvas 2D presenter", ({ page }) => check(page, "cpu"));
  test("WebGPU presenter", ({ page }) => check(page, "gpu"));
});
