import { expect, type Page, test } from "@playwright/test";

/** The history panel's step names, oldest first (UI-FTW-04). */
const LAST_STEP = "ol.app-history-list li:last-child .app-history-name";

/** The engine canvas, without the overlays that sit on top of it. */
const ENGINE_CANVAS = "[data-backend] canvas:not(.app-canvas-overlay)";

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly count: number;
}

/**
 * The boxes of the near-black pixels left and right of `split` (page x), in page coordinates,
 * from a screenshot of the engine canvas.
 */
async function darkBoxes(page: Page, split: number): Promise<{ left: Box; right: Box }> {
  const canvas = await page.locator(ENGINE_CANVAS).boundingBox();
  if (canvas === null) throw new Error("the engine canvas has no box");
  const png = await page.locator(ENGINE_CANVAS).screenshot();
  return page.evaluate(
    async ({ base64, origin, split }) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context === null) throw new Error("no 2D context");
      context.drawImage(bitmap, 0, 0);
      const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      const empty = () => ({ left: 1e9, right: -1e9, top: 1e9, bottom: -1e9, count: 0 });
      const boxes = { left: empty(), right: empty() };
      // Dark, even under the selection's tint; the marching ants are thin lines, so a pixel
      // counts only when its four neighbours are dark too.
      const dark = (x: number, y: number) => {
        if (x < 0 || y < 0 || x >= width || y >= height) return false;
        const i = (y * width + x) * 4;
        return (data[i] ?? 0) < 80 && (data[i + 1] ?? 0) < 80 && (data[i + 2] ?? 0) < 80;
      };
      // Only the middle of the image, away from the dark workspace around it.
      const [x0, x1] = [
        Math.max(0, Math.floor(split - 300 - origin.x)),
        Math.min(width, Math.floor(split + 150 - origin.x)),
      ];
      const middle = Math.floor(height / 2);
      const [y0, y1] = [Math.max(0, middle - 150), Math.min(height, middle + 150)];
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const solid =
            dark(x, y) && dark(x - 1, y) && dark(x + 1, y) && dark(x, y - 1) && dark(x, y + 1);
          if (!solid) continue;
          const [px, py] = [origin.x + x, origin.y + y];
          const box = px < split ? boxes.left : boxes.right;
          box.left = Math.min(box.left, px);
          box.right = Math.max(box.right, px + 1);
          box.top = Math.min(box.top, py);
          box.bottom = Math.max(box.bottom, py + 1);
          box.count += 1;
        }
      }
      return boxes;
    },
    { base64: png.toString("base64"), origin: { x: canvas.x, y: canvas.y }, split },
  );
}

async function drag(page: Page, points: readonly Point[]) {
  const [first, ...rest] = points;
  if (first === undefined) throw new Error("a drag needs points");
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const point of rest) await page.mouse.move(point.x, point.y, { steps: 8 });
  await page.mouse.up();
}

async function selectTool(page: Page, name: string) {
  await page.getByRole("radio", { name, exact: true }).click();
  await expect(page.getByRole("radio", { name, exact: true })).toBeChecked();
}

/** Fills the rectangle between two points with the primary color (black). */
async function fillRect(page: Page, from: Point, to: Point) {
  await selectTool(page, "Rectangle Select");
  await drag(page, [from, to]);
  await expect(page.locator(LAST_STEP)).toHaveText("Rectangle Select");
  await page.keyboard.press("Backspace");
  await expect(page.locator(LAST_STEP)).toHaveText("Fill Selection");
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

test("Flip Horizontal mirrors a lasso selection's pixels and outline in one step, and undo restores both (FX-OBJ-FLIP)", async ({
  page,
}) => {
  const canvas = await page.locator(ENGINE_CANVAS).boundingBox();
  if (canvas === null) throw new Error("the engine canvas has no box");
  const cx = Math.round(canvas.x + canvas.width / 2);
  const cy = Math.round(canvas.y + canvas.height / 2);
  const at = (dx: number, dy: number): Point => ({ x: cx + dx, y: cy + dy });
  const split = cx + 70;

  // On a transparent layer: a black block R near the left of where the selection will be, and a
  // block S to the right, outside it.
  await page.keyboard.press("Control+Shift+N");
  await expect(page.locator(LAST_STEP)).toHaveText("New Layer");
  await fillRect(page, at(-150, -20), at(-120, 20));
  await fillRect(page, at(110, -20), at(150, 20));
  await page.keyboard.press("Control+D");

  // A triangle pointing right, its tall edge on the left around R: its box is x -160 to 40, so
  // the mirror line is at x -60. Mirrored, R lands at x 0 to 30, where the original triangle
  // is too thin to hold it, so only a mirrored outline covers it.
  await selectTool(page, "Lasso Select");
  await drag(page, [at(-160, -80), at(40, 0), at(-160, 80), at(-160, -80)]);
  await expect(page.locator(LAST_STEP)).toHaveText("Lasso Select");

  const before = await darkBoxes(page, split);
  expect(before.left.count).toBeGreaterThan(400);
  expect(Math.abs(before.left.left - (cx - 150))).toBeLessThanOrEqual(3);
  expect(Math.abs(before.left.right - (cx - 120))).toBeLessThanOrEqual(3);

  await page.getByRole("button", { name: "Effects", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Object/ }).click();
  await page.getByRole("menuitem", { name: "Flip Horizontal", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(LAST_STEP)).toHaveText("Flip Horizontal");

  const mirrorLine = cx - 60;
  await expect(async () => {
    const after = await darkBoxes(page, split);
    // R moved to its mirror image; its old place is clear; S is untouched.
    expect(Math.abs(after.left.left - (2 * mirrorLine - before.left.right))).toBeLessThanOrEqual(4);
    expect(Math.abs(after.left.right - (2 * mirrorLine - before.left.left))).toBeLessThanOrEqual(4);
    expect(after.left.top).toBe(before.left.top);
    expect(after.left.bottom).toBe(before.left.bottom);
    expect(Math.abs(after.left.count - before.left.count)).toBeLessThanOrEqual(
      before.left.count / 20,
    );
    expect(after.right).toEqual(before.right);
  }).toPass();

  // The selection was mirrored with the pixels: erasing it clears the moved block completely.
  await page.keyboard.press("Delete");
  await expect(page.locator(LAST_STEP)).toHaveText("Erase Selection");
  await expect(async () => {
    const erased = await darkBoxes(page, split);
    expect(erased.left.count).toBe(0);
    expect(erased.right).toEqual(before.right);
  }).toPass();

  // Undo the erase and the flip: the block is back, and so is the original triangle, which
  // erases the block where it first was.
  await page.keyboard.press("Control+Z");
  await page.keyboard.press("Control+Z");
  await expect(async () => {
    expect(await darkBoxes(page, split)).toEqual(before);
  }).toPass();
  await page.keyboard.press("Delete");
  await expect(async () => {
    const erased = await darkBoxes(page, split);
    expect(erased.left.count).toBe(0);
    expect(erased.right).toEqual(before.right);
  }).toPass();
});

test("Flip Vertical with nothing selected mirrors the whole layer and Repeat flips it back", async ({
  page,
}) => {
  const canvas = await page.locator(ENGINE_CANVAS).boundingBox();
  if (canvas === null) throw new Error("the engine canvas has no box");
  const cx = Math.round(canvas.x + canvas.width / 2);
  const cy = Math.round(canvas.y + canvas.height / 2);
  const at = (dx: number, dy: number): Point => ({ x: cx + dx, y: cy + dy });

  await page.keyboard.press("Control+Shift+N");
  await fillRect(page, at(-40, -90), at(0, -50));
  await page.keyboard.press("Control+D");
  await expect(page.locator(LAST_STEP)).toHaveText("Deselect");
  const before = await darkBoxes(page, cx + 100);

  await page.getByRole("button", { name: "Effects", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Object/ }).click();
  await page.getByRole("menuitem", { name: "Flip Vertical", exact: true }).click();
  await expect(page.locator(LAST_STEP)).toHaveText("Flip Vertical");
  await expect(async () => {
    const after = await darkBoxes(page, cx + 100);
    // The image is centred, so the block lands mirrored about the canvas's middle row.
    expect(Math.abs(after.left.top - (2 * cy - before.left.bottom))).toBeLessThanOrEqual(4);
    expect(after.left.left).toBe(before.left.left);
    expect(after.left.count).toBe(before.left.count);
  }).toPass();

  await page.keyboard.press("Control+F");
  await expect(page.locator(LAST_STEP)).toHaveText("Flip Vertical");
  await expect(async () => {
    expect(await darkBoxes(page, cx + 100)).toEqual(before);
  }).toPass();
});
