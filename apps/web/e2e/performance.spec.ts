import { expect, type Page, test } from "@playwright/test";

/**
 * Performance smoke tests (PRD-NF-02). The browser reports every main-thread
 * task over 50 ms as a `longtask` entry, so each gesture is measured by the tasks it adds.
 *
 * Only Chromium reports `longtask`. Firefox and WebKit run the same gestures, but their budgets are
 * not measured here, so those tests are skipped there.
 */

/**
 * The longest main-thread task the editing gestures may run (PRD-NF-02). The commit tests start
 * their window once the dialog is up, so they measure the commit itself: an effect's OK and Resize
 * each copy the layer and encode it in a worker.
 */
const TASK_BUDGET_MS = 50;

const LONG_TASK_SKIP = "The longtask entries that the budgets read exist only in Chromium.";

/** The engine canvas, without the overlays that sit on top of it. */
const ENGINE_CANVAS = "[data-backend] canvas:not(.app-canvas-overlay)";

declare global {
  interface Window {
    __longTasks: number[];
  }
}

interface Point {
  readonly x: number;
  readonly y: number;
}

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__longTasks = [];
    if (PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__longTasks.push(entry.duration);
      }).observe({ type: "longtask", buffered: true });
    }
  });
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  await page.locator(".app-canvas-area").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Control+B");
  await expect(page.locator(".app-status-zoom")).toHaveText(/\d+%/);
  await page.waitForTimeout(500);
});

async function canvasCenter(page: Page): Promise<Point> {
  const box = await page.locator(ENGINE_CANVAS).boundingBox();
  if (box === null) throw new Error("the engine canvas has no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** The longest task recorded since `from`, once the page has had time to report it. */
async function longestTaskSince(page: Page, from: number): Promise<number> {
  await page.waitForTimeout(300);
  const tasks = await page.evaluate(() => window.__longTasks.slice());
  return Math.max(0, ...tasks.slice(from));
}

async function taskCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__longTasks.length);
}

test("painting a stroke keeps every main-thread task under the budget (PRD-NF-02)", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", LONG_TASK_SKIP);
  const center = await canvasCenter(page);
  const from = await taskCount(page);
  await page.getByRole("radio", { name: "Paintbrush", exact: true }).click();
  await page.mouse.move(center.x - 150, center.y);
  await page.mouse.down();
  for (let i = 0; i < 20; i++) {
    await page.mouse.move(center.x - 150 + i * 15, center.y + Math.sin(i) * 60, { steps: 2 });
  }
  await page.mouse.up();
  await expect(page.locator("ol.app-history-list li:last-child .app-history-name")).toHaveText(
    "Paintbrush",
  );
  expect(await longestTaskSince(page, from)).toBeLessThanOrEqual(TASK_BUDGET_MS);
});

test("panning with Space and a drag keeps every main-thread task under the budget (PRD-NF-02)", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", LONG_TASK_SKIP);
  const center = await canvasCenter(page);
  const from = await taskCount(page);
  await page.keyboard.down("Space");
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  for (let i = 0; i < 20; i++) {
    await page.mouse.move(center.x + i * 10, center.y + i * 5, { steps: 2 });
  }
  await page.mouse.up();
  await page.keyboard.up("Space");
  expect(await longestTaskSince(page, from)).toBeLessThanOrEqual(TASK_BUDGET_MS);
});

test("committing an effect keeps the longest main-thread task within the commit budget (PRD-NF-02)", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", LONG_TASK_SKIP);
  await page.getByRole("button", { name: "Effects", exact: true }).click();
  await page.getByRole("menuitem", { name: /Blurs/ }).hover();
  await page.getByRole("menuitem", { name: /^Gaussian Blur/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const from = await taskCount(page);
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("ol.app-history-list li:last-child .app-history-name")).toHaveText(
    "Gaussian Blur",
  );
  expect(await longestTaskSince(page, from)).toBeLessThanOrEqual(TASK_BUDGET_MS);
});

test("resizing to 3000 px wide keeps the longest main-thread task within the commit budget (PRD-NF-02)", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", LONG_TASK_SKIP);
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Resize/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const from = await taskCount(page);
  await page.getByLabel("Width", { exact: true }).first().fill("3000");
  await page.getByLabel("Width", { exact: true }).first().press("Tab");
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("ol.app-history-list li:last-child .app-history-name")).toHaveText(
    "Resize",
  );
  expect(await longestTaskSince(page, from)).toBeLessThanOrEqual(TASK_BUDGET_MS);
});
