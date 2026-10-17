/// <reference types="node" />
import { expect, type Page, test } from "@playwright/test";
import { ENGINE_CANVAS } from "./touch-input";

/**
 * Design-review screenshots of the app on touch devices: phone and tablet sizes in both
 * orientations, with touch emulation, in both schemes. They run only when MOBILE_REVIEW_DIR names
 * the folder to write them to, so the regular suite skips them.
 */
const DIR = process.env.MOBILE_REVIEW_DIR;
const LABEL = process.env.MOBILE_REVIEW_LABEL ?? "shot";

const SIZES = [
  { name: "phone-portrait", width: 390, height: 844, scale: 3 },
  { name: "phone-landscape", width: 844, height: 390, scale: 3 },
  { name: "tablet-portrait", width: 768, height: 1024, scale: 2 },
  { name: "tablet-landscape", width: 1180, height: 820, scale: 2 },
] as const;

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${DIR}/${name}.png` });
}

/** Runs one optional review step; a step the layout does not offer is skipped. */
async function step(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.log(`skipped ${name}: ${String(error).split("\n")[0]}`);
  }
}

for (const size of SIZES) {
  for (const scheme of ["light", "dark"] as const) {
    test(`mobile review ${size.name} ${scheme}`, async ({ browser, browserName }) => {
      test.skip(DIR === undefined, "MOBILE_REVIEW_DIR is not set");
      test.skip(browserName !== "chromium", "touch emulation with isMobile is Chromium-only");
      test.setTimeout(180_000);
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        deviceScaleFactor: size.scale,
        hasTouch: true,
        isMobile: true,
        colorScheme: scheme,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      await page.goto("/");
      await expect(page.locator(ENGINE_CANVAS)).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(1500);
      const name = `${LABEL}-${size.name}-${scheme}`;
      await shot(page, `${name}-window`);

      await step("panels", async () => {
        for (const panel of ["Layers", "Colors", "History", "Tools"] as const) {
          const toggle = page.locator(`[data-panel-toggle="${panel.toLowerCase()}"]`);
          if ((await toggle.count()) === 0) return;
          await toggle.click();
          await shot(page, `${name}-panel-${panel.toLowerCase()}`);
          await toggle.click();
        }
      });
      await step("menu", async () => {
        const opener = page.locator("[data-menu-opener]");
        if ((await opener.count()) > 0) {
          await opener.click();
          await page.getByRole("menuitem", { name: "Effects" }).click();
        } else await page.getByRole("button", { name: "Effects", exact: true }).click();
        await shot(page, `${name}-menu`);
        await page.getByRole("menuitem", { name: "Blurs" }).click();
        await page.getByRole("menuitem", { name: /^Gaussian Blur/ }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await shot(page, `${name}-dialog`);
        await page.getByRole("button", { name: "Cancel" }).click();
      });
      await step("tool options", async () => {
        await page
          .locator(".app-tool-config")
          .getByRole("button", { name: "More options" })
          .click();
        await shot(page, `${name}-tool-more`);
        await page.keyboard.press("Escape");
      });
      await step("settings", async () => {
        const opener = page.locator("[data-menu-opener]");
        if ((await opener.count()) > 0) {
          await opener.click();
          await page.getByRole("menuitem", { name: /^Settings/ }).click();
        } else await page.getByRole("button", { name: "Settings" }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await shot(page, `${name}-settings`);
        await page.keyboard.press("Escape");
      });
      await context.close();
    });
  }
}
