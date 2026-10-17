import { expect, test } from "@playwright/test";

test("the common-actions strip enables Deselect with a selection and toggles the pixel grid", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  const bar = page.getByRole("toolbar", { name: "Common actions" });
  const deselect = bar.getByRole("button", { name: "Deselect" });
  const undo = bar.getByRole("button", { name: "Undo" });
  await expect(bar.getByRole("button", { name: "New" })).toBeEnabled();
  await expect(deselect).toBeDisabled();
  await expect(bar.getByRole("button", { name: "Crop to Selection" })).toBeDisabled();

  await page.keyboard.press("Control+A");
  await expect(deselect).toBeEnabled();
  await expect(bar.getByRole("button", { name: "Crop to Selection" })).toBeEnabled();
  await expect(undo).toBeEnabled();
  await deselect.click();
  await expect(deselect).toBeDisabled();
  await page.keyboard.press("Alt+E");
  await expect(page.getByRole("menu").getByRole("menuitem", { name: /^Deselect/ })).toBeDisabled();
  await page.keyboard.press("Escape");

  const grid = bar.getByRole("button", { name: "Display pixel grid when zoomed in" });
  await expect(grid).toHaveAttribute("aria-pressed", "false");
  await grid.click();
  await expect(grid).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Alt+V");
  await expect(
    page.getByRole("menu").getByRole("menuitemcheckbox", { name: /Pixel grid/ }),
  ).toBeChecked();
  await page.keyboard.press("Escape");
  await grid.click();
  await expect(grid).toHaveAttribute("aria-pressed", "false");

  // The strip stays when the last image closes, with the image buttons off.
  await page.keyboard.press("Alt+W");
  await page.getByRole("button", { name: "Don't Save" }).click();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("button", { name: "Open" })).toBeEnabled();
  await expect(bar.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(bar.getByRole("button", { name: "Undo" })).toBeDisabled();
});

test("an image tab's unsaved-changes badge takes the close button's place until hover (UI-TABS-02, UI-TABS-03)", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  await page.mouse.move(700, 600);
  const close = page.locator(".app-image-tab-close");
  await expect(close).toHaveCSS("opacity", "1");
  // Select All records a history item, so the image has unsaved changes.
  await page.keyboard.press("Control+A");
  const dirty = page.locator(".app-image-tab-dirty");
  await expect(dirty).toHaveCSS("opacity", "1");
  await expect(close).toHaveCSS("opacity", "0");
  const badge = await dirty.boundingBox();
  const button = await close.boundingBox();
  const tab = await page.getByRole("tab").boundingBox();
  if (badge === null || button === null || tab === null) throw new Error("missing box");
  // The badge is centred in the close button's place, inside the tab.
  expect(Math.abs(badge.x + badge.width / 2 - (button.x + button.width / 2))).toBeLessThan(1);
  expect(Math.abs(badge.y + badge.height / 2 - (button.y + button.height / 2))).toBeLessThan(1);
  expect(badge.y + badge.height).toBeLessThanOrEqual(tab.y + tab.height);

  await page.getByRole("tab").hover();
  await expect(close).toHaveCSS("opacity", "1");
  await expect(dirty).toHaveCSS("opacity", "0");
});
