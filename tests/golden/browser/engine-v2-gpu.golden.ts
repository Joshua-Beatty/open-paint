import { V2_COMPOSITE_CASES, V2_STROKE_CASES } from "@openpaint/engine/v2-cases";
import { expect, type Page, test } from "@playwright/test";
import { GPU_TOLERANCE } from "../src/compare";

type Runner = "runV2CompositeCase" | "runV2StrokeCase" | "runV2SyncCase";

async function check(page: Page, runner: Runner, id: string) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
      errors.push(message.text());
    }
  });
  await page.goto("/browser/index.html");
  const result = await page.evaluate(([name, kase]) => window[name](kase), [runner, id] as const);
  if (result === null) {
    test.skip(true, "No WebGPU adapter in this browser; GPU golden checks are skipped.");
    return;
  }
  expect(errors).toEqual([]);
  expect(
    result.maxDifference,
    `${id}: ${result.differingChannels} channels differ`,
  ).toBeLessThanOrEqual(GPU_TOLERANCE);
}

test.describe("engine v2 compositor: WGSL against compositeCpu (±1)", () => {
  for (const kase of V2_COMPOSITE_CASES) {
    test(kase.id, ({ page }) => check(page, "runV2CompositeCase", kase.id));
  }
});

test.describe("engine v2 stroke: committed GPU stroke against strokeBrushCpu (±1)", () => {
  for (const kase of V2_STROKE_CASES) {
    test(kase.id, ({ page }) => check(page, "runV2StrokeCase", kase.id));
  }
});

test.describe("engine v2 document sync: partial tile uploads (exact)", () => {
  test("partial-sync", ({ page }) => check(page, "runV2SyncCase", "partial-sync"));
});
