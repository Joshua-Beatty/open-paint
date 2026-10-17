import { expect, test } from "@playwright/test";

test("keyboard-only Edit commands change the first-run image, undo and mark it dirty", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page).toHaveTitle("Untitled - OpenPaint");

  await page.keyboard.press("Control+A");
  await page.keyboard.press("Alt+E");
  const edit = page.getByRole("menu");
  await expect(edit.getByRole("menuitem", { name: /^Deselect/ })).toBeEnabled();
  await expect(edit.getByRole("menuitem", { name: /^Erase Selection/ })).toBeEnabled();
  await page.keyboard.press("Escape");

  await page.keyboard.press("Delete");
  await expect(page).toHaveTitle("*Untitled - OpenPaint");

  await page.keyboard.press("Control+Z");
  await page.keyboard.press("Control+Z");
  await expect(page).toHaveTitle("Untitled - OpenPaint");

  await page.keyboard.press("Alt+E");
  await expect(page.getByRole("menu").getByRole("menuitem", { name: /^Deselect/ })).toBeDisabled();
  await page.keyboard.press("Escape");
});
