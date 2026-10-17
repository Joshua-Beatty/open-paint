import { expect, type Page, test } from "@playwright/test";

const ENGINE_CANVAS = "[data-backend] canvas:not(.app-canvas-overlay)";

test.use({ viewport: { width: 1440, height: 900 } });

async function canvasCenter(page: Page) {
  const box = await page.locator(ENGINE_CANVAS).boundingBox();
  if (box === null) throw new Error("the engine canvas has no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test("the selection's marching ants keep moving while a brush stroke is held (owner request)", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.locator(".app-status-zoom")).toHaveText(/\d+%/);
  const center = await canvasCenter(page);

  await page.getByRole("radio", { name: "Rectangle Select", exact: true }).click();
  await page.mouse.move(center.x - 150, center.y - 100);
  await page.mouse.down();
  await page.mouse.move(center.x + 150, center.y + 100, { steps: 6 });
  await page.mouse.up();

  await page.getByRole("radio", { name: "Paintbrush", exact: true }).click();
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 10, center.y + 5, { steps: 3 });

  // A strip of the selection's top edge, far from the stroke: only the ants change there.
  const edge = { x: center.x - 100, y: center.y - 104, width: 60, height: 8 };
  const first = await page.screenshot({ clip: edge });
  await expect
    .poll(async () => (await page.screenshot({ clip: edge })).equals(first), { timeout: 2000 })
    .toBe(false);
  await page.mouse.up();
});
