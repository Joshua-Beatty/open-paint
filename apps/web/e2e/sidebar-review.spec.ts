/// <reference types="node" />
import { expect, test } from "@playwright/test";

/**
 * Design-review screenshots of the whole window with the Colors panel compact and expanded, the
 * Tools panel, the palette with a hovered swatch, and the status bar's zoom slider, at two window
 * sizes in both schemes. They run only when UI_REVIEW_DIR names the folder to write them to, so
 * the regular suite skips them.
 */
const DIR = process.env.UI_REVIEW_DIR;
const LABEL = process.env.UI_REVIEW_LABEL ?? "shot";

for (const [width, height] of [
  [1920, 1080],
  [1440, 900],
] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`sidebar review ${width}x${height} ${scheme}`, async ({ page, browserName }) => {
      test.skip(DIR === undefined, "UI_REVIEW_DIR is not set");
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.setViewportSize({ width, height });
      await page.goto("/");
      await expect(page.getByRole("tab")).toHaveCount(1);
      const name = `${LABEL}-${browserName}-${width}x${height}-${scheme}`;
      await page.screenshot({ path: `${DIR}/${name}-less.png` });
      await page
        .locator(".app-status-zoom-slider")
        .screenshot({ path: `${DIR}/${name}-zoom-slider.png` });
      await page.locator(".app-sidebar-left").screenshot({ path: `${DIR}/${name}-tools.png` });
      await page.getByRole("button", { name: "More >>" }).click();
      await expect(page.getByRole("button", { name: "<< Less" })).toBeVisible();
      await page.screenshot({ path: `${DIR}/${name}-more.png` });
      await page.locator(".color-palette-swatch").nth(20).hover();
      await page.locator(".color-palette").screenshot({ path: `${DIR}/${name}-palette-hover.png` });
    });
  }
}

for (const scheme of ["light", "dark"] as const) {
  test(`zoom slider close-up ${scheme}`, async ({ browser, browserName }) => {
    test.skip(DIR === undefined, "UI_REVIEW_DIR is not set");
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 4,
      colorScheme: scheme,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByRole("tab")).toHaveCount(1);
    await expect(page.locator(".app-status-zoom-slider")).not.toHaveAttribute("data-disabled");
    const box = await page.locator(".app-status-zoom-slider").boundingBox();
    if (box === null) throw new Error("no zoom slider");
    await page.screenshot({
      path: `${DIR}/${LABEL}-${browserName}-${scheme}-zoom-slider-4x.png`,
      clip: { x: box.x - 24, y: box.y - 4, width: box.width + 48, height: box.height + 8 },
    });
    await page.getByRole("radio", { name: "Shapes" }).click();
    await page.locator(".tools-grid").screenshot({
      path: `${DIR}/${LABEL}-${browserName}-${scheme}-tools-shapes-4x.png`,
    });
    await context.close();
  });
}
