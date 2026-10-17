import { expect, type Page, test } from "@playwright/test";

/**
 * The app fills the window exactly: nothing runs past the viewport, so the page itself never
 * scrolls (UI-WIN-01), with the Colors panel compact or expanded and with a dialog open.
 */
const SIZES = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1280, height: 720 },
];

async function expectNoPageScroll(page: Page) {
  const size = page.viewportSize();
  if (size === null) throw new Error("no viewport");
  const scroll = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  }));
  expect(scroll).toEqual({ width: size.width, height: size.height });
}

for (const size of SIZES) {
  test(`the page does not scroll at ${size.width} x ${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto("/");
    await expect(page.getByRole("tab")).toHaveCount(1);
    await expectNoPageScroll(page);

    await page.getByRole("button", { name: "More >>" }).click();
    await expect(page.getByRole("button", { name: "<< Less" })).toBeVisible();
    await expectNoPageScroll(page);

    await page.getByRole("button", { name: "Layer Properties", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectNoPageScroll(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.getByRole("button", { name: "<< Less" }).click();
    await expectNoPageScroll(page);
  });
}
