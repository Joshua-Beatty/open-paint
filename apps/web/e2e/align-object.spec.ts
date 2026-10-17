import { expect, type Page, test } from "@playwright/test";

/** The history panel's step names, oldest first (UI-FTW-04). */
const LAST_STEP = "ol.app-history-list li:last-child .app-history-name";

/** The engine canvas, without the overlays that sit on top of it. */
const ENGINE_CANVAS = "[data-backend] canvas:not(.app-canvas-overlay)";

interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly count: number;
}

/** The screen boxes of the white image and of the near-black pixels on it, from a screenshot. */
async function boxes(page: Page): Promise<{ readonly image: Box; readonly dark: Box }> {
  const png = await page.locator(ENGINE_CANVAS).screenshot();
  return page.evaluate(async (base64) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context === null) throw new Error("no 2D context");
    context.drawImage(bitmap, 0, 0);
    const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const empty = () => ({ left: width, top: height, right: -1, bottom: -1, count: 0 });
    const white = empty();
    const dark = empty();
    const grow = (box: ReturnType<typeof empty>, x: number, y: number) => {
      box.left = Math.min(box.left, x);
      box.top = Math.min(box.top, y);
      box.right = Math.max(box.right, x);
      box.bottom = Math.max(box.bottom, y);
      box.count += 1;
    };
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const [r, g, b] = [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0];
        if (r >= 250 && g >= 250 && b >= 250) grow(white, x, y);
        else if (r <= 30 && g <= 30 && b <= 30) grow(dark, x, y);
      }
    }
    return { image: white, dark };
  }, png.toString("base64"));
}

/** `boxes` while a dialog is open: the dialog and its dimmed backdrop are hidden for the shot. */
async function boxesUnderDialog(page: Page): Promise<{ readonly image: Box; readonly dark: Box }> {
  const style = await page.addStyleTag({ content: ".modal-overlay { opacity: 0 !important; }" });
  try {
    return await boxes(page);
  } finally {
    await style.evaluate((element) => (element as ChildNode).remove());
  }
}

async function openAlignObject(page: Page) {
  await page.getByRole("button", { name: "Effects", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Object/ }).hover();
  await page.getByRole("menuitem", { name: /^Align Object/ }).click();
  await expect(page.getByRole("dialog", { name: "Align Object" })).toBeVisible();
}

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.getByRole("radio").first()).toBeVisible();
  await page.locator(".app-canvas-area").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Control+B");
  await expect(page.locator(".app-status-zoom")).toHaveText(/\d+%/);
});

test("Align Object moves a small object to the top-left corner of the image (FX-OBJ-ALIGN)", async ({
  page,
}) => {
  // A transparent layer with a small black rectangle right of and below the image's center.
  await page.keyboard.press("Control+Shift+N");
  await expect(page.locator(LAST_STEP)).toHaveText("New Layer");
  const canvas = await page.locator(ENGINE_CANVAS).boundingBox();
  if (canvas === null) throw new Error("the engine canvas has no box");
  const cx = canvas.x + canvas.width / 2;
  const cy = canvas.y + canvas.height / 2;
  await page.getByRole("radio", { name: "Rectangle Select", exact: true }).click();
  await page.mouse.move(cx + 40, cy + 30);
  await page.mouse.down();
  await page.mouse.move(cx + 100, cy + 70, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(LAST_STEP)).toHaveText("Rectangle Select");
  await page.keyboard.press("Backspace");
  await expect(page.locator(LAST_STEP)).toHaveText("Fill Selection");
  await page.keyboard.press("Control+D");
  await expect(page.locator(LAST_STEP)).toHaveText("Deselect");

  const before = await boxes(page);
  expect(before.dark.count).toBeGreaterThan(100);
  expect(before.dark.left).toBeGreaterThan(before.image.left + 20);

  await openAlignObject(page);
  const dialog = page.getByRole("dialog", { name: "Align Object" });
  await expect(dialog.getByRole("radio", { name: "Original Position", exact: true })).toBeChecked();
  await expect(dialog.getByRole("status")).toHaveCount(0);
  // The positions are a 4 x 4 grid of icon buttons: Top Left is the first cell of the second row,
  // under the horizontal-only row.
  const grid = dialog.getByRole("radiogroup", { name: "Position" });
  const cells = grid.locator(".prop-choice-cell");
  await expect(cells).toHaveCount(16);
  const topLeft = cells.filter({ hasText: /^Top Left$/ });
  const left = cells.filter({ hasText: /^Left$/ });
  const topLeftBox = await topLeft.boundingBox();
  const leftBox = await left.boundingBox();
  if (topLeftBox === null || leftBox === null) throw new Error("the grid cells have no box");
  expect(Math.abs(topLeftBox.x - leftBox.x)).toBeLessThanOrEqual(1);
  expect(topLeftBox.y).toBeGreaterThan(leftBox.y + leftBox.height);
  await topLeft.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Top Left");
  await topLeft.click();
  await expect(dialog.getByRole("radio", { name: "Top Left", exact: true })).toBeChecked();
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(LAST_STEP)).toHaveText("Align Object");

  await expect(async () => {
    const after = await boxes(page);
    // The object now sits in the image's top-left corner, at the same size, and its old place
    // is white again: it moved rather than copied.
    expect(Math.abs(after.dark.left - after.image.left)).toBeLessThanOrEqual(2);
    expect(Math.abs(after.dark.top - after.image.top)).toBeLessThanOrEqual(2);
    expect(Math.abs(after.dark.count - before.dark.count)).toBeLessThanOrEqual(
      before.dark.count / 10,
    );
    expect(after.dark.right).toBeLessThan(before.dark.left);
  }).toPass();
});

test("Align Object always opens at Original Position, Reset returns there, and Repeat runs OK's choice", async ({
  page,
}) => {
  await page.keyboard.press("Control+Shift+N");
  await expect(page.locator(LAST_STEP)).toHaveText("New Layer");
  const canvas = await page.locator(ENGINE_CANVAS).boundingBox();
  if (canvas === null) throw new Error("the engine canvas has no box");
  const cx = canvas.x + canvas.width / 2;
  const cy = canvas.y + canvas.height / 2;
  await page.getByRole("radio", { name: "Rectangle Select", exact: true }).click();
  await page.mouse.move(cx + 40, cy + 30);
  await page.mouse.down();
  await page.mouse.move(cx + 100, cy + 70, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(LAST_STEP)).toHaveText("Rectangle Select");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Control+D");
  await expect(page.locator(LAST_STEP)).toHaveText("Deselect");
  const before = await boxes(page);

  await openAlignObject(page);
  const dialog = page.getByRole("dialog", { name: "Align Object" });
  const original = dialog.getByRole("radio", { name: "Original Position", exact: true });
  await expect(original).toBeChecked();
  // Opening the dialog leaves the object where it is.
  await page.waitForTimeout(300);
  expect((await boxesUnderDialog(page)).dark).toEqual(before.dark);

  await dialog
    .locator(".prop-choice-cell")
    .filter({ hasText: /^Top Left$/ })
    .click();
  await expect(async () => {
    const moved = await boxesUnderDialog(page);
    expect(Math.abs(moved.dark.left - moved.image.left)).toBeLessThanOrEqual(2);
  }).toPass();
  await dialog.getByRole("button", { name: "Reset Position" }).click();
  await expect(original).toBeChecked();
  await expect(async () => {
    expect((await boxesUnderDialog(page)).dark).toEqual(before.dark);
  }).toPass();

  // OK at Bottom Right: the next open still starts at Original Position, and Repeat runs Bottom Right.
  await dialog
    .locator(".prop-choice-cell")
    .filter({ hasText: /^Bottom Right$/ })
    .click();
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.locator(LAST_STEP)).toHaveText("Align Object");
  // Undo (the step stays listed, greyed, until it is redone or replaced).
  await page.keyboard.press("Control+Z");
  await expect(async () => {
    expect((await boxes(page)).dark).toEqual(before.dark);
  }).toPass();
  await openAlignObject(page);
  await expect(original).toBeChecked();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Control+F");
  await expect(page.locator(LAST_STEP)).toHaveText("Align Object");
  await expect(async () => {
    const after = await boxes(page);
    expect(Math.abs(after.dark.right - after.image.right)).toBeLessThanOrEqual(2);
    expect(Math.abs(after.dark.bottom - after.image.bottom)).toBeLessThanOrEqual(2);
  }).toPass();
});

test("Align Object on the opaque background shows the filled notice and records nothing", async ({
  page,
}) => {
  await openAlignObject(page);
  const dialog = page.getByRole("dialog", { name: "Align Object" });
  await expect(dialog.getByRole("status")).toHaveText(
    "The canvas or selection is filled, or the object touches all four edges. Nothing will be aligned.",
  );
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(LAST_STEP)).not.toHaveText("Align Object");
});
