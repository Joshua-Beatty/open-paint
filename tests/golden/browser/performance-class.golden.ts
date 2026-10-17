import { expect, test } from "@playwright/test";

test("the startup GPU benchmark runs without GPU errors (SET-DLG-07)", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/browser/index.html");
  const result = await page.evaluate(() => window.runPerformanceClass());
  if (result === null) {
    test.skip(true, "No WebGPU adapter in this browser; GPU golden checks are skipped.");
    return;
  }
  expect(errors).toEqual([]);
  expect(result.errors).toEqual([]);
  expect(["Low", "Good"]).toContain(result.performanceClass);
});
