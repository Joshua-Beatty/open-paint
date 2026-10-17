import { expect, type Locator, type Page, test } from "@playwright/test";

/** The history panel's step names, oldest first (UI-FTW-04). */
const LAST_STEP = "ol.app-history-list li:last-child .app-history-name";

/** The engine canvas, without the overlays that sit on top of it. */
const ENGINE_CANVAS = "[data-backend] canvas:not(.app-canvas-overlay)";

/** How much of the title bar stays on screen horizontally. */
const MIN_VISIBLE = 96;

/** A screenshot of the canvas with any open dialog hidden. */
async function canvasShot(page: Page): Promise<Buffer> {
  const style = await page.addStyleTag({ content: ".modal-overlay { opacity: 0 !important; }" });
  try {
    return await page.locator(ENGINE_CANVAS).screenshot();
  } finally {
    await style.evaluate((element) => (element as ChildNode).remove());
  }
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("no layout box");
  return box;
}

async function openGaussianBlur(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Effects", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Blurs/ }).hover();
  await page.getByRole("menuitem", { name: /^Gaussian Blur/ }).click();
  const dialog = page.getByRole("dialog", { name: "Gaussian Blur" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Drags the title bar of `dialog` by `dx`, `dy`, from the left of its part on screen. */
async function dragTitle(page: Page, dialog: Locator, dx: number, dy: number) {
  const header = await boxOf(dialog.locator(".modal-header"));
  const x = Math.max(header.x, 0) + 8;
  const y = Math.max(header.y, 0) + 10;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

/** Drags the title bar of `dialog` from `grabX` px into it (negative: from its right end) to `to`. */
async function dragTitleTo(
  page: Page,
  dialog: Locator,
  grabX: number,
  to: { readonly x: number; readonly y: number },
) {
  const header = await boxOf(dialog.locator(".modal-header"));
  const x = grabX >= 0 ? header.x + grabX : header.x + header.width + grabX;
  const y = header.y + 10;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move((x + to.x) / 2, (y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.getByRole("radio").first()).toBeVisible();
});

test("an effect dialog moves with its title bar, keeps previewing, and reopens where it was left", async ({
  page,
}) => {
  // A filled rectangle, so the blur preview changes the canvas.
  await page.locator(".app-canvas-area").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Control+B");
  const canvas = await boxOf(page.locator(ENGINE_CANVAS));
  const cx = canvas.x + canvas.width / 2;
  const cy = canvas.y + canvas.height / 2;
  await page.getByRole("radio", { name: "Rectangle Select", exact: true }).click();
  await page.mouse.move(cx - 60, cy - 40);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy + 40, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(LAST_STEP)).toHaveText("Rectangle Select");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Control+D");
  await expect(page.locator(LAST_STEP)).toHaveText("Deselect");
  const before = await canvasShot(page);

  const dialog = await openGaussianBlur(page);
  const frame = page.locator(".modal");
  // The canvas behind a previewing dialog is not dimmed.
  expect(
    await page
      .locator(".modal-overlay")
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ).toBe("rgba(0, 0, 0, 0)");
  await expect(dialog.locator(".modal-header")).toHaveCSS("cursor", "move");
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toHaveCSS(
    "cursor",
    "pointer",
  );
  await expect.poll(async () => (await canvasShot(page)).equals(before)).toBe(false);
  const centred = await boxOf(frame);

  await dragTitle(page, dialog, -300, 100);
  const moved = await boxOf(frame);
  expect(Math.abs(moved.x - (centred.x - 300))).toBeLessThanOrEqual(1);
  expect(Math.abs(moved.y - (centred.y + 100))).toBeLessThanOrEqual(1);
  // Dragging selects no text.
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");

  // The preview still follows the dialog's values after the move.
  const blurred = await canvasShot(page);
  const radius = dialog.getByRole("textbox", { name: "Radius" });
  await radius.fill("40");
  await radius.press("Tab");
  await expect.poll(async () => (await canvasShot(page)).equals(blurred)).toBe(false);

  // Reopened, the dialog is where it was left, and its keyboard still works.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await canvasShot(page)).equals(before)).toBe(true);
  await openGaussianBlur(page);
  const reopened = await boxOf(frame);
  expect(Math.abs(reopened.x - moved.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(reopened.y - moved.y)).toBeLessThanOrEqual(1);
  await dialog.getByRole("textbox", { name: "Radius" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(LAST_STEP)).toHaveText("Gaussian Blur");
});

test("a dialog's title bar stays reachable however far it is dragged, and double-click centres it", async ({
  page,
}) => {
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("no viewport");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  const frame = page.locator(".modal");
  const header = dialog.locator(".modal-header");
  const centred = await boxOf(frame);

  // Grabbed near its right end and dragged into the top-left corner: the bar's top stays inside,
  // and 96 px of it.
  await dragTitleTo(page, dialog, -60, { x: 1, y: 1 });
  let box = await boxOf(frame);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeLessThanOrEqual(1);
  expect(box.x + box.width).toBeGreaterThanOrEqual(MIN_VISIBLE - 1);
  expect(box.x + box.width).toBeLessThanOrEqual(MIN_VISIBLE + 1);
  // What is left on screen beside the close button still drags it.
  await dragTitleTo(page, dialog, -60, { x: 300, y: 200 });
  box = await boxOf(frame);
  expect(box.x + box.width).toBeGreaterThan(300);

  // Grabbed near its left end and dragged into the bottom-right corner: all of the bar stays
  // inside the bottom, and 96 px of it inside the right.
  await dragTitleTo(page, dialog, -60, { x: viewport.width - 1, y: 200 });
  await dragTitleTo(page, dialog, 8, { x: viewport.width - 1, y: viewport.height - 1 });
  const bar = await boxOf(header);
  box = await boxOf(frame);
  expect(bar.y + bar.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(bar.y + bar.height).toBeGreaterThanOrEqual(viewport.height - 1);
  expect(box.x).toBeLessThanOrEqual(viewport.width - MIN_VISIBLE + 1);
  expect(box.x).toBeGreaterThanOrEqual(viewport.width - MIN_VISIBLE - 1);

  // A smaller window pulls the bar back inside.
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect
    .poll(async () => {
      const now = await boxOf(header);
      return now.y + now.height <= 701 && now.x <= 1000 - MIN_VISIBLE + 1;
    })
    .toBe(true);

  // Double-clicking the title bar centres the dialog again.
  await page.setViewportSize(viewport);
  const again = await boxOf(header);
  await page.mouse.dblclick(again.x + 24, again.y + 10);
  await expect
    .poll(async () => {
      const now = await boxOf(frame);
      return Math.abs(now.x - centred.x) <= 1 && Math.abs(now.y - centred.y) <= 1;
    })
    .toBe(true);

  // Escape still closes it.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("other dialogs keep the dimmed backdrop", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  expect(
    await page
      .locator(".modal-overlay")
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ).not.toBe("rgba(0, 0, 0, 0)");
});
