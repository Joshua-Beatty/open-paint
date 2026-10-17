/// <reference types="node" />
import { expect, test } from "@playwright/test";

/**
 * Design-review screenshots of the header (menu bar, common actions, tool options) and the whole
 * window, in both schemes at the two reference sizes. They run only when UI_REVIEW_DIR names the
 * folder to write them to, so the regular suite skips them.
 */
const DIR = process.env.UI_REVIEW_DIR;
const LABEL = process.env.UI_REVIEW_LABEL ?? "shot";

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

/** Tools whose option strips show the widest range of controls. */
const TOOLS = ["Paintbrush", "Paint Bucket", "Text", "Shapes"] as const;

for (const scheme of ["light", "dark"] as const) {
  for (const size of SIZES) {
    test(`ui review ${scheme} ${size.width}x${size.height}`, async ({ page }) => {
      test.skip(DIR === undefined, "UI_REVIEW_DIR is not set");
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.setViewportSize(size);
      await page.goto("/");
      await expect(page.getByRole("tab")).toHaveCount(1);
      const name = `${LABEL}-${scheme}-${size.width}x${size.height}`;
      await page.screenshot({ path: `${DIR}/${name}-window.png` });
      for (const tool of TOOLS) {
        await page.getByRole("radio", { name: tool, exact: true }).click();
        const header = await page.locator(".app-image-tabs").boundingBox();
        await page.screenshot({
          path: `${DIR}/${name}-header-${tool.replaceAll(" ", "").toLowerCase()}.png`,
          clip: { x: 0, y: 0, width: size.width, height: header?.y ?? 120 },
        });
      }

      // An open drop-down of the options bar, with its list.
      await page.getByRole("radio", { name: "Paintbrush", exact: true }).click();
      await page.locator(".app-tool-config").getByRole("button", { name: /^Fill/ }).click();
      await expect(page.getByRole("listbox")).toBeVisible();
      await page.screenshot({
        path: `${DIR}/${name}-dropdown.png`,
        clip: { x: 0, y: 0, width: Math.min(size.width, 1100), height: 420 },
      });
      await page.keyboard.press("Escape");

      if (scheme === "dark" || size.width === 1440) {
        await page.getByRole("button", { name: "Settings" }).click();
        await page.locator(".settings-section", { hasText: "Tools" }).click();
        await page.screenshot({ path: `${DIR}/${name}-settings.png` });
        await page.keyboard.press("Escape");
      }
    });
  }

  // The image tabs with unsaved changes: the active tab, a second tab, and one under the pointer.
  test(`ui review tabs ${scheme}`, async ({ page }) => {
    test.skip(DIR === undefined, "UI_REVIEW_DIR is not set");
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("tab")).toHaveCount(1);
    // Select All records a history item, so it leaves the image with unsaved changes.
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Control+N");
    await page.getByRole("button", { name: "OK" }).click();
    await expect(page.getByRole("tab")).toHaveCount(2);
    await page.keyboard.press("Control+A");
    await expect(page.locator(".app-image-tab-dirty")).toHaveCount(2);
    await page.mouse.move(700, 600);
    await page.waitForTimeout(1200);
    const strip = await page.locator(".app-image-tabs").boundingBox();
    if (strip === null) throw new Error("no tab strip");
    const clip = { x: 0, y: strip.y, width: 400, height: strip.height };
    const name = `${LABEL}-${scheme}`;
    await page.screenshot({ path: `${DIR}/${name}-tabs.png`, clip });
    await page.getByRole("tab").first().hover();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${DIR}/${name}-tabs-hover.png`, clip });
  });
}
