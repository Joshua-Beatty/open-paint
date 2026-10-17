import { expect, test } from "@playwright/test";

test("keyboard-only View menu toggles the rulers and the pixel grid, and the page keys scroll", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.locator(".app-ruler")).toHaveCount(0);

  await page.keyboard.press("Alt+V");
  await page.keyboard.press("r");
  await expect(page.locator(".app-ruler")).toHaveCount(2);

  await page.keyboard.press("Escape");
  await page.keyboard.press("Alt+V");
  await page.keyboard.press("g");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Alt+V");
  const view = page.getByRole("menu");
  await expect(view.getByRole("menuitemcheckbox", { name: /Pixel grid/ })).toBeChecked();
  await expect(view.getByRole("menuitemcheckbox", { name: /Rulers/ })).toBeChecked();
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+0");
  await page.locator(".app-canvas-area").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("PageDown");
  await page.keyboard.press("Shift+PageDown");
  await page.keyboard.press("Home");
  await page.keyboard.press("End");
  await expect(page.locator(".app-ruler")).toHaveCount(2);

  await page.keyboard.press("Escape");
  await page.keyboard.press("Alt+V");
  await page.keyboard.press("r");
  await expect(page.locator(".app-ruler")).toHaveCount(0);
});
