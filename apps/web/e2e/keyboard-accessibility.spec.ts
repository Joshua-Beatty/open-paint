import { expect, test } from "@playwright/test";

test("keyboard-only: the right sidebar's width splitter resizes with the arrow keys", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  const splitter = page.getByRole("separator", { name: "Resize the right sidebar" });
  await splitter.focus();
  await expect(splitter).toBeFocused();
  const before = Number(await splitter.getAttribute("aria-valuenow"));
  await page.keyboard.press("ArrowLeft");
  expect(Number(await splitter.getAttribute("aria-valuenow"))).toBeGreaterThan(before);
  await page.keyboard.press("ArrowRight");
  expect(Number(await splitter.getAttribute("aria-valuenow"))).toBe(before);
});

test("keyboard-only: a panel splitter moves with the up and down arrows", async ({ page }) => {
  // The Colors panel is pinned at its compact height, so the Layers and History splitter moves.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  const splitter = page.getByRole("separator", { name: "Resize the Layers and History panels" });
  await splitter.focus();
  await expect(splitter).toBeFocused();
  const before = Number(await splitter.getAttribute("aria-valuenow"));
  await page.keyboard.press("ArrowDown");
  expect(Number(await splitter.getAttribute("aria-valuenow"))).toBeGreaterThan(before);
});

test("keyboard-only: Alt+I then R opens Resize, Tab stays inside it, and Escape closes it", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  await page.keyboard.press("Alt+I");
  await page.keyboard.press("r");

  const dialog = page.locator(".modal-dialog");
  await expect(dialog).toBeVisible();
  for (let press = 0; press < 12; press++) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(
      () => document.activeElement?.closest(".modal-dialog") !== null,
    );
    expect(inside, `Tab ${press + 1} left the dialog`).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("keyboard-only: the arrow keys move between image tabs", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  await page.keyboard.press("Control+N");
  await expect(page.locator(".modal-dialog")).toBeVisible();
  await page.getByRole("button", { name: "OK" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".modal-dialog")).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(2);

  const tabs = page.getByRole("tab");
  await tabs.nth(0).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
});

test("reduced motion stops transitions and running animations, including in menus and dialogs", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);

  await page.keyboard.press("Alt+E");
  await expect(page.getByRole("menu")).toBeVisible();
  const motion = await page.evaluate(() => ({
    transitions: [...document.querySelectorAll("*")].filter((element) =>
      getComputedStyle(element)
        .transitionDuration.split(",")
        .some((duration) => Number.parseFloat(duration) > 0),
    ).length,
    animations: document
      .getAnimations()
      .filter(
        (animation) =>
          animation.playState === "running" &&
          animation.effect?.getComputedTiming().endTime !== Infinity,
      ).length,
  }));
  expect(motion).toEqual({ transitions: 0, animations: 0 });
  await page.keyboard.press("Escape");
});
