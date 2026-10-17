import { expect, type Page, test } from "@playwright/test";
import { canvasBox, ENGINE_CANVAS, pixelBounds, Touchscreen } from "./touch-input";

/**
 * Touch input on phones and tablets (WEB-PTR-03): one finger draws, two fingers pinch-zoom and
 * pan, a two-finger tap undoes. The phone and tablet projects run this file with touch emulation.
 */

test.skip(({ browserName }) => browserName !== "chromium", "multi-touch goes through CDP");

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(ENGINE_CANVAS)).toBeVisible();
  // The engine has presented the white start image.
  await expect.poll(async () => (await pixelBounds(page, "white")).count).toBeGreaterThan(1000);
}

function zoomText(page: Page) {
  return page.locator(".app-status-zoom").first();
}

function undoButton(page: Page) {
  return page.getByRole("button", { name: "Undo", exact: true }).first();
}

test("one finger draws a stroke, and a two-finger tap undoes it", async ({ page }) => {
  await open(page);
  const box = await canvasBox(page);
  const touch = new Touchscreen(page);
  const y = box.y + box.height / 2;
  await touch.drag([{ x: box.x + box.width * 0.35, y }], [{ x: box.x + box.width * 0.65, y }]);
  await expect(undoButton(page)).toBeEnabled();
  await expect.poll(async () => (await pixelBounds(page, "ink")).count).toBeGreaterThan(20);

  await touch.start([
    { x: box.x + box.width * 0.4, y: y - 40 },
    { x: box.x + box.width * 0.6, y: y - 40 },
  ]);
  await touch.end();
  await expect(undoButton(page)).toBeDisabled();
  await expect.poll(async () => (await pixelBounds(page, "ink")).count).toBe(0);
});

test("pinching zooms around the fingers without drawing", async ({ page }) => {
  await open(page);
  const box = await canvasBox(page);
  const before = Number.parseFloat((await zoomText(page).textContent()) ?? "0");
  const touch = new Touchscreen(page);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await touch.drag(
    [
      { x: cx - 30, y: cy },
      { x: cx + 30, y: cy },
    ],
    [
      { x: cx - 90, y: cy },
      { x: cx + 90, y: cy },
    ],
  );
  await expect
    .poll(async () => Number.parseFloat((await zoomText(page).textContent()) ?? "0"))
    .toBeGreaterThan(before * 2);
  await expect(undoButton(page)).toBeDisabled();
  expect((await pixelBounds(page, "ink")).count).toBe(0);
});

test("two fingers pan the view", async ({ page }) => {
  await open(page);
  const box = await canvasBox(page);
  const before = await pixelBounds(page, "white");
  const touch = new Touchscreen(page);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await touch.drag(
    [
      { x: cx - 40, y: cy },
      { x: cx + 40, y: cy },
    ],
    [
      { x: cx - 40 + 60, y: cy + 40 },
      { x: cx + 40 + 60, y: cy + 40 },
    ],
  );
  await expect
    .poll(async () => (await pixelBounds(page, "white")).left - before.left)
    .toBeGreaterThan(40);
  const after = await pixelBounds(page, "white");
  expect(after.top - before.top).toBeGreaterThan(25);
  await expect(undoButton(page)).toBeDisabled();
});

test("the compact layout fits the screen with no page scrolling", async ({ page }) => {
  await open(page);
  const overflow = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth - innerWidth,
    height: document.documentElement.scrollHeight - innerHeight,
  }));
  expect(overflow).toEqual({ width: 0, height: 0 });
  await expect(page.locator(".app-shell.is-compact")).toHaveCount(1);
  await expect(page.getByRole("toolbar", { name: "Modifier keys" })).toBeVisible();
});

test("the Layers sheet adds a layer, and the top bar's Undo takes it back", async ({ page }) => {
  await open(page);
  await page.locator('[data-panel-toggle="layers"]').tap();
  const sheet = page.getByRole("region", { name: "Layers" });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".app-layer-row")).toHaveCount(1);
  await sheet.getByRole("button", { name: "Add New Layer" }).tap();
  await expect(sheet.locator(".app-layer-row")).toHaveCount(2);
  await undoButton(page).tap();
  await expect(sheet.locator(".app-layer-row")).toHaveCount(1);
  await sheet.getByRole("button", { name: "Close Layers" }).tap();
  await expect(sheet).toHaveCount(0);
});

test("an effect runs from the menu in a sheet that leaves the preview in sight", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "Menu", exact: true }).tap();
  await page.getByRole("menuitem", { name: "Effects" }).tap();
  await page.getByRole("menuitem", { name: "Blurs" }).tap();
  await page.getByRole("menuitem", { name: /^Gaussian Blur/ }).tap();
  const dialog = page.getByRole("dialog", { name: "Gaussian Blur" });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize();
  if (box === null || viewport === null) throw new Error("no dialog box");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(box.y).toBeGreaterThan(viewport.height * 0.3);
  await dialog.getByRole("button", { name: "OK" }).tap();
  await expect(dialog).toHaveCount(0);
  await expect(undoButton(page)).toBeEnabled();
});

test("a second finger after the stroke began cancels it, leaving no paint and no step", async ({
  page,
}) => {
  await open(page);
  const box = await canvasBox(page);
  const touch = new Touchscreen(page);
  const y = box.y + box.height / 2;
  const x = box.x + box.width * 0.3;
  await touch.start([{ x, y }]);
  for (let step = 1; step <= 8; step++) {
    await touch.move([{ x: x + step * 10, y }]);
    await page.waitForTimeout(25);
  }
  await expect.poll(async () => (await pixelBounds(page, "ink")).count).toBeGreaterThan(0);
  await touch.move([
    { x: x + 80, y },
    { x: x + 80, y: y + 60 },
  ]);
  await touch.move([
    { x: x + 90, y },
    { x: x + 90, y: y + 80 },
  ]);
  await touch.end();
  await expect.poll(async () => (await pixelBounds(page, "ink")).count).toBe(0);
  await expect(undoButton(page)).toBeDisabled();
});
