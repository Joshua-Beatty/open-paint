/// <reference types="node" />
import { expect, test } from "@playwright/test";

/**
 * Design-review screenshots of the right sidebar's Colors panel (compact and expanded) and the
 * History panel, in both schemes. They run only when UI_REVIEW_DIR names the folder to write them
 * to, so the regular suite skips them.
 */
const DIR = process.env.UI_REVIEW_DIR;
const LABEL = process.env.UI_REVIEW_LABEL ?? "shot";

for (const scheme of ["light", "dark"] as const) {
  test(`panels review ${scheme}`, async ({ page }) => {
    test.skip(DIR === undefined, "UI_REVIEW_DIR is not set");
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 1200 });
    await page.goto("/");
    await expect(page.getByRole("tab")).toHaveCount(1);
    const name = `${LABEL}-${scheme}`;
    const colors = page.locator(".colors-panel");
    await colors.screenshot({ path: `${DIR}/${name}-colors-less.png` });
    await page.getByRole("button", { name: "More >>" }).click();
    await expect(page.getByRole("button", { name: "<< Less" })).toBeVisible();
    // The expanded panel scrolls in its body; show all of it above the panels below.
    const unclip = await page.addStyleTag({
      content: `*:has(.colors-panel) { overflow: visible !important; }
        .colors-panel { position: relative; z-index: 10; background: var(--panel-background); }`,
    });
    await colors.screenshot({ path: `${DIR}/${name}-colors-more.png` });
    await unclip.evaluate((element) => element.parentNode?.removeChild(element));
    await page.getByRole("button", { name: "<< Less" }).click();

    for (const shortcut of ["Control+Shift+N", "Control+A", "Control+Shift+D", "Control+D"]) {
      await page.keyboard.press(shortcut);
    }
    await expect(page.locator("ol.app-history-list li")).toHaveCount(5);
    await page.keyboard.press("Control+Z");
    await page.locator(".app-history").screenshot({ path: `${DIR}/${name}-history.png` });
  });
}
