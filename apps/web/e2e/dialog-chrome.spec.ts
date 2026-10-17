import { expect, type Locator, type Page, test } from "@playwright/test";

/** The history panel's step names, oldest first (UI-FTW-04). */
const LAST_STEP = "ol.app-history-list li:last-child .app-history-name";

/** The engine canvas, without the overlays that sit on top of it. */
const ENGINE_CANVAS = "[data-backend] canvas:not(.app-canvas-overlay)";

/** A screenshot of the canvas with any open dialog and its backdrop hidden. */
async function canvasShot(page: Page): Promise<Buffer> {
  const style = await page.addStyleTag({ content: ".modal-overlay { opacity: 0 !important; }" });
  try {
    return await page.locator(ENGINE_CANVAS).screenshot();
  } finally {
    await style.evaluate((element) => (element as ChildNode).remove());
  }
}

/** The close button in the title bar of `dialog`, checked for its place, size and name. */
async function titleClose(dialog: Locator): Promise<Locator> {
  const close = dialog.locator(".modal-header").getByRole("button", { name: "Close", exact: true });
  await expect(close).toHaveCount(1);
  const box = await close.boundingBox();
  const frame = await dialog.boundingBox();
  const title = await dialog.locator(".modal-title").first().boundingBox();
  if (box === null || frame === null || title === null) throw new Error("no layout boxes");
  // A 28 to 32 px target in the top-right corner, beside the title rather than over it.
  expect(box.width).toBeGreaterThanOrEqual(28);
  expect(box.width).toBeLessThanOrEqual(32);
  expect(box.height).toBeGreaterThanOrEqual(28);
  expect(box.height).toBeLessThanOrEqual(32);
  expect(frame.x + frame.width - (box.x + box.width)).toBeLessThanOrEqual(16);
  expect(box.y - frame.y).toBeLessThanOrEqual(16);
  expect(title.x + title.width).toBeLessThanOrEqual(box.x + 1);
  return close;
}

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.getByRole("radio").first()).toBeVisible();
});

test("the close button of an effect dialog cancels the preview and restores the layer, like Cancel", async ({
  page,
}) => {
  await page.locator(".app-canvas-area").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Control+B");
  const canvas = await page.locator(ENGINE_CANVAS).boundingBox();
  if (canvas === null) throw new Error("the engine canvas has no box");
  const cx = canvas.x + canvas.width / 2;
  const cy = canvas.y + canvas.height / 2;
  await page.getByRole("radio", { name: "Rectangle Select", exact: true }).click();
  await page.mouse.move(cx - 60, cy - 40);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy + 40, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(LAST_STEP)).toHaveText("Rectangle Select");
  await page.keyboard.press("Backspace");
  await expect(page.locator(LAST_STEP)).toHaveText("Fill Selection");
  await page.keyboard.press("Control+D");
  await expect(page.locator(LAST_STEP)).toHaveText("Deselect");
  const before = await canvasShot(page);

  await page.getByRole("button", { name: "Effects", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Blurs/ }).hover();
  await page.getByRole("menuitem", { name: /^Gaussian Blur/ }).click();
  const dialog = page.getByRole("dialog", { name: "Gaussian Blur" });
  await expect(dialog).toBeVisible();
  // The preview blurs the rectangle's edges on the layer.
  await expect.poll(async () => (await canvasShot(page)).equals(before)).toBe(false);

  await (await titleClose(dialog)).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await canvasShot(page)).equals(before)).toBe(true);
  await expect(page.locator(LAST_STEP)).toHaveText("Deselect");

  // Escape still cancels the same way.
  await page.getByRole("button", { name: "Effects", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Blurs/ }).hover();
  await page.getByRole("menuitem", { name: /^Gaussian Blur/ }).click();
  await expect(dialog).toBeVisible();
  await expect.poll(async () => (await canvasShot(page)).equals(before)).toBe(false);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await canvasShot(page)).equals(before)).toBe(true);
});

test("Settings closes from its title bar's close button and has no bottom Close button", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toHaveCount(1);
  await (await titleClose(dialog)).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("About and Keyboard Shortcuts have no footer Close: focus starts in the dialog, Tab reaches the close button, Esc closes", async ({
  page,
}) => {
  for (const [item, title] of [
    [/^About/, "About OpenPaint"],
    [/^Keyboard Shortcuts/, "Keyboard Shortcuts"],
  ] as const) {
    await page.getByRole("button", { name: "Help", exact: true }).click();
    await page.getByRole("menuitem", { name: item }).click();
    const dialog = page.getByRole("dialog", { name: title });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toHaveCount(1);
    await expect(dialog.locator(".modal-actions")).toHaveCount(0);
    await expect
      .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
      .toBe(true);
    await page.keyboard.press("Tab");
    await expect(
      dialog.locator(".modal-header").getByRole("button", { name: "Close" }),
    ).toBeFocused();
    // Keyboard focus shows no tooltip on the close button, so one Esc closes the dialog.
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
});

/** Items with an ellipsis that open a native file or print picker, not an in-page dialog. */
const NATIVE_PICKER = /^(Open\.\.\.|Save As\.\.\.|Print\.\.\.|Import From File\.\.\.)/;

/** Every dialog opened from a menu has the close button, and it closes the dialog. */
test("every dialog opened from a menu has a title bar close button that closes it", async ({
  page,
}) => {
  test.setTimeout(600_000);
  const menuBar = page.locator(".app-menu-list .app-menu-button");
  const newest = () => page.getByRole("menu").last();
  const closeMenus = async () => {
    for (let attempt = 0; attempt < 5 && (await page.getByRole("menu").count()) > 0; attempt++) {
      await page.keyboard.press("Escape");
    }
    await expect(page.getByRole("menu")).toHaveCount(0);
  };
  const entries = async () =>
    newest()
      .getByRole("menuitem")
      .evaluateAll((items) =>
        items.map((item) => ({
          label: item.textContent ?? "",
          enabled: item.getAttribute("aria-disabled") !== "true",
          group: item.classList.contains("app-menu-group"),
        })),
      );
  const open = async (chain: readonly number[]) => {
    await closeMenus();
    for (const [depth, index] of chain.entries()) {
      if (depth === 0) await menuBar.nth(index).click();
      else await newest().getByRole("menuitem").nth(index).click();
      await expect(page.getByRole("menu")).toHaveCount(depth + 1);
    }
  };
  let choosers = 0;
  page.on("filechooser", () => {
    choosers++;
  });
  const checked: string[] = [];
  const check = async (chain: readonly number[], position: number, label: string) => {
    await open(chain);
    const before = choosers;
    await newest().getByRole("menuitem").nth(position).click();
    const dialog = page.locator(".modal-dialog");
    await expect
      .poll(async () => (await dialog.count()) > 0 || choosers > before, { message: label })
      .toBe(true);
    if ((await dialog.count()) === 0) {
      await closeMenus();
      return;
    }
    await (await titleClose(dialog.last())).click();
    await expect(dialog, label).toHaveCount(0);
    checked.push(label);
  };
  const isDialog = (entry: { label: string; enabled: boolean; group: boolean }) =>
    entry.enabled &&
    !entry.group &&
    entry.label.includes("...") &&
    !NATIVE_PICKER.test(entry.label);

  const count = await menuBar.count();
  for (let index = 0; index < count; index++) {
    await open([index]);
    for (const [position, entry] of (await entries()).entries()) {
      if (entry.group && entry.enabled) {
        await open([index, position]);
        for (const [sub, item] of (await entries()).entries()) {
          if (isDialog(item)) await check([index, position], sub, `${entry.label}>${item.label}`);
        }
      } else if (isDialog(entry)) {
        await check([index], position, entry.label);
      }
    }
  }
  expect(checked.length).toBeGreaterThan(40);
});
