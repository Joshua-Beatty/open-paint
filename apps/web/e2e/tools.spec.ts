import { expect, type Page, test } from "@playwright/test";

/** The history panel's step names, oldest first (UI-FTW-04). */
const LAST_STEP = "ol.app-history-list li:last-child .app-history-name";

/** The engine canvas, without the overlays that sit on top of it. */
const ENGINE_CANVAS = "[data-backend] canvas:not(.app-canvas-overlay)";

interface Point {
  readonly x: number;
  readonly y: number;
}

async function canvasCenter(page: Page): Promise<Point> {
  const canvas = page.locator(ENGINE_CANVAS);
  await expect(canvas).toHaveCount(1);
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("the engine canvas has no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A point offset from the center of the canvas, where the first-run image is. */
function offset(center: Point, dx: number, dy: number): Point {
  return { x: center.x + dx, y: center.y + dy };
}

async function selectTool(page: Page, name: string) {
  await page.getByRole("radio", { name, exact: true }).click();
  await expect(page.getByRole("radio", { name, exact: true })).toBeChecked();
}

/** Presses on the first point, drags through the others, and releases on the last. */
async function drag(page: Page, points: readonly Point[]) {
  const [first, ...rest] = points;
  if (first === undefined) throw new Error("a drag needs points");
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const point of rest) await page.mouse.move(point.x, point.y, { steps: 6 });
  await page.mouse.up();
}

async function click(page: Page, point: Point) {
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.up();
}

/**
 * The canvas as the engine presents it, from a screenshot: the overlays (the transform frame, the
 * handles) are hidden, since at 100 % the frame lies right on a shape's outline.
 */
const CANVAS_ONLY = ".app-canvas-overlay { visibility: hidden !important; }";

/** How many pixels of a page region are pure red, from a screenshot of the presented canvas. */
async function redPixels(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
): Promise<number> {
  const png = await page.screenshot({ clip, style: CANVAS_ONLY });
  return page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
    if (context === null) throw new Error("no 2D context");
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if ((pixels[i] ?? 0) > 200 && (pixels[i + 1] ?? 0) < 60 && (pixels[i + 2] ?? 0) < 60) {
        count++;
      }
    }
    return count;
  }, png.toString("base64"));
}

/** The bounds of the pure red pixels of a page region, from a screenshot, in CSS pixels. */
async function redBounds(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
): Promise<{ left: number; top: number; right: number; bottom: number }> {
  const png = await page.screenshot({ clip, style: CANVAS_ONLY });
  return page.evaluate(
    async ({ data, cssWidth }) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
      if (context === null) throw new Error("no 2D context");
      context.drawImage(bitmap, 0, 0);
      const {
        data: pixels,
        width,
        height,
      } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      let left = width;
      let top = height;
      let right = -1;
      let bottom = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const red =
            (pixels[i] ?? 0) > 200 && (pixels[i + 1] ?? 0) < 60 && (pixels[i + 2] ?? 0) < 60;
          if (!red) continue;
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      }
      const scale = width / cssWidth;
      return { left: left / scale, top: top / scale, right: right / scale, bottom: bottom / scale };
    },
    { data: png.toString("base64"), cssWidth: clip.width },
  );
}

/** The bounds of the dark pixels of a page region, from a screenshot, in CSS pixels of the region. */
async function darkBounds(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
): Promise<{ left: number; top: number; right: number; bottom: number }> {
  const png = await page.screenshot({ clip, style: CANVAS_ONLY });
  return page.evaluate(
    async ({ data, cssWidth }) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
      if (context === null) throw new Error("no 2D context");
      context.drawImage(bitmap, 0, 0);
      const {
        data: pixels,
        width,
        height,
      } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      let left = width;
      let top = height;
      let right = -1;
      let bottom = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          // Darker than the grey around the image, which a small image leaves inside the region.
          if (Math.max(pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0) > 30) continue;
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      }
      // Screenshots are at the screen's scale, which can be 2 even where the page reports 1
      // (desktop Firefox over WebDriver BiDi on a high-DPI screen).
      const scale = width / cssWidth;
      return { left: left / scale, top: top / scale, right: right / scale, bottom: bottom / scale };
    },
    { data: png.toString("base64"), cssWidth: clip.width },
  );
}

// The tool gestures are sized for a fitted image, so the canvas needs room beyond the default 720 px.
test.use({ viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.getByRole("radio").first()).toBeVisible();
  // The view commands wait for the engine, which shows the zoom once it has laid out the image;
  // a key pressed before then does nothing.
  await expect(page.locator(".app-status-zoom")).toHaveText(/\d+%/);
  await page.locator(".app-canvas-area").click({ position: { x: 4, y: 4 } });
  // From Zoom to Window to Actual Size, so every gesture below runs at 100 %.
  await page.keyboard.press("Control+B");
  await expect(page.locator(".app-status-zoom")).toHaveText("100%");
});

test("the S, M and O hotkeys select tools and cycle through their group (TL-HOTKEY-01)", async ({
  page,
}) => {
  await page.locator(ENGINE_CANVAS).click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("s");
  await expect(page.getByRole("radio", { name: "Rectangle Select", exact: true })).toBeChecked();
  await page.keyboard.press("s");
  await expect(page.getByRole("radio", { name: "Lasso Select", exact: true })).toBeChecked();
  await page.keyboard.press("o");
  await expect(page.getByRole("radio", { name: "Line / Curve", exact: true })).toBeChecked();
});

test("a tool's tooltip never blocks the tool under it, and leaves with the pointer", async ({
  page,
}) => {
  const tools = page.locator(".app-sidebar-left").getByRole("radio");
  const names = await tools.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("aria-label") ?? ""),
  );
  // Hover a tool in a lower row so its tooltip, above it, lies over the tools in the row above.
  const hovered = tools.nth(Math.min(names.length - 1, 6));
  await hovered.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toBeVisible({ timeout: 5000 });
  const tip = await tooltip.boundingBox();
  if (tip === null) throw new Error("the tooltip has no box");
  const tipCenter = { x: tip.x + tip.width / 2, y: tip.y + tip.height / 2 };
  // The tool whose button lies under the tooltip's middle.
  let target = -1;
  for (let index = 0; index < names.length; index++) {
    const box = await tools.nth(index).boundingBox();
    if (box === null) continue;
    const inside = (x: number, y: number) =>
      x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
    if (inside(tipCenter.x, tipCenter.y) || inside(tipCenter.x, tip.y + tip.height - 2)) {
      target = index;
      break;
    }
  }
  expect(target, "a tool lies under the tooltip").toBeGreaterThanOrEqual(0);
  const targetBox = await tools.nth(target).boundingBox();
  if (targetBox === null) throw new Error("the target tool has no box");
  const point = {
    x: Math.min(Math.max(tipCenter.x, targetBox.x + 2), targetBox.x + targetBox.width - 2),
    y: Math.min(Math.max(tipCenter.y, targetBox.y + 2), targetBox.y + targetBox.height - 2),
  };
  // The tooltip does not take the pointer, and closes as soon as the pointer leaves its tool.
  expect(
    await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="tooltip"]') === null,
      point,
    ),
  ).toBe(true);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByRole("radio", { name: names[target], exact: true })).toBeChecked();
  await page.mouse.move(point.x + 400, point.y);
  await expect(tooltip).toHaveCount(0, { timeout: 300 });
});

test("a tooltip still shows for keyboard focus (WEB-A11Y)", async ({ page }) => {
  const first = page.locator(".app-sidebar-left").getByRole("radio").first();
  await first.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tooltip")).toBeVisible();
});

test("a held click near the canvas edge does not auto-scroll the fitted view (TL-HOTKEY-03)", async ({
  page,
}) => {
  const status = page.locator(".app-status-bar");
  // Back to Zoom to Window: the toggle then offers Actual Size ("1:1").
  await page.keyboard.press("Control+B");
  await expect(status).toContainText("1:1");
  const zoom = await page.locator(".app-status-zoom").textContent();
  const box = await page.locator(ENGINE_CANVAS).boundingBox();
  if (box === null) throw new Error("the engine canvas has no box");
  await selectTool(page, "Paintbrush");
  // Inside the auto-scroll band, held for many frames without leaving the click dead zone.
  await page.mouse.move(box.x + 4, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + 6, box.y + 5);
  await page.waitForTimeout(400);
  await page.mouse.up();
  await expect(status).toContainText("1:1");
  await expect(page.locator(".app-status-zoom")).toHaveText(zoom ?? "");
});

/** The canvas area's focus ring: its outline and box shadow. */
async function canvasRing(page: Page): Promise<string> {
  return page.locator(".app-canvas-area").evaluate((el) => {
    const style = getComputedStyle(el);
    const outline =
      style.outlineStyle === "none" ? "none" : `${style.outlineStyle} ${style.outlineWidth}`;
    return `${outline} / ${style.boxShadow}`;
  });
}

test("modifier keys during a canvas drag never outline the canvas area (WEB-A11Y)", async ({
  page,
}) => {
  const center = await canvasCenter(page);
  const none = await canvasRing(page);
  expect(none).toMatch(/^none /);
  /** Drags from `from` to `to` holding `key` from just after the press. */
  const dragHolding = async (key: string, from: Point, to: Point) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.keyboard.down(key);
    await page.mouse.move(to.x, to.y, { steps: 4 });
    expect(await canvasRing(page)).toBe(none);
    await page.mouse.up();
    await page.keyboard.up(key);
    expect(await canvasRing(page)).toBe(none);
  };
  await selectTool(page, "Shapes");
  await drag(page, [offset(center, -120, -80), offset(center, 120, 80)]);
  for (const key of ["Shift", "Alt", "Control"]) {
    await dragHolding(key, offset(center, 120, 80), offset(center, 140, 90));
    await page.keyboard.press("Control+Z");
  }
  await selectTool(page, "Rectangle Select");
  await dragHolding("Shift", offset(center, -100, -60), offset(center, 60, 40));
  await dragHolding("Control", offset(center, -50, -50), offset(center, 80, 70));
  await selectTool(page, "Move Selection");
  await dragHolding("Shift", offset(center, -30, -20), offset(center, 0, 0));

  // Focus that the keyboard brings back to the canvas still shows the ring.
  await page.keyboard.press("Tab");
  await page.locator(".app-canvas-area").evaluate((el) => (el as HTMLElement).focus());
  expect(await canvasRing(page)).not.toBe(none);
});

test("Rectangle Select drag records one selection step", async ({ page }) => {
  const center = await canvasCenter(page);
  await selectTool(page, "Rectangle Select");
  await drag(page, [offset(center, -120, -80), offset(center, 120, 80)]);
  await expect(page.locator(LAST_STEP)).toHaveText("Rectangle Select");
});

test("a Rectangle Select click with 2 px of jitter deselects (TL-SEL-01)", async ({ page }) => {
  const center = await canvasCenter(page);
  await selectTool(page, "Rectangle Select");
  await drag(page, [offset(center, -120, -80), offset(center, 120, 80)]);
  await expect(page.locator(LAST_STEP)).toHaveText("Rectangle Select");
  await drag(page, [offset(center, 200, 150), offset(center, 202, 151), offset(center, 201, 152)]);
  await expect(page.locator(LAST_STEP)).toHaveText("Deselect");
});

test("Ellipse Select drag records one selection step", async ({ page }) => {
  const center = await canvasCenter(page);
  await selectTool(page, "Ellipse Select");
  await drag(page, [offset(center, -120, -80), offset(center, 120, 80)]);
  await expect(page.locator(LAST_STEP)).toHaveText("Ellipse Select");
});

test("Lasso Select follows a freehand path and records one selection step", async ({ page }) => {
  const center = await canvasCenter(page);
  await selectTool(page, "Lasso Select");
  await drag(page, [
    offset(center, -100, 0),
    offset(center, 0, -100),
    offset(center, 100, 0),
    offset(center, 0, 100),
    offset(center, -100, 0),
  ]);
  await expect(page.locator(LAST_STEP)).toHaveText("Lasso Select");
});

test("Magic Wand click selects a region, and Enter finishes it", async ({ page }) => {
  await selectTool(page, "Magic Wand");
  await click(page, await canvasCenter(page));
  await expect(page.locator(LAST_STEP)).toHaveText("Magic Wand");
  await page.keyboard.press("Enter");
  await expect(page.locator(LAST_STEP)).toHaveText("Finish Magic Wand");
});

test("Paint Bucket click fills a region, and Enter finishes it", async ({ page }) => {
  await selectTool(page, "Paint Bucket");
  await click(page, await canvasCenter(page));
  await expect(page.locator(LAST_STEP)).toHaveText("Paint Bucket");
  await page.keyboard.press("Enter");
  await expect(page.locator(LAST_STEP)).toHaveText("Finish Paint Bucket");
});

test("Paintbrush drag records one stroke", async ({ page }) => {
  const center = await canvasCenter(page);
  await selectTool(page, "Paintbrush");
  await drag(page, [offset(center, -80, -40), offset(center, 80, 40)]);
  await expect(page.locator(LAST_STEP)).toHaveText("Paintbrush");
});

test("Pencil drag records one stroke", async ({ page }) => {
  const center = await canvasCenter(page);
  await selectTool(page, "Pencil");
  await drag(page, [offset(center, -80, -40), offset(center, 80, 40)]);
  await expect(page.locator(LAST_STEP)).toHaveText("Pencil");
});

test("Eraser drag records one stroke", async ({ page }) => {
  const center = await canvasCenter(page);
  await selectTool(page, "Eraser");
  await drag(page, [offset(center, -80, -40), offset(center, 80, 40)]);
  await expect(page.locator(LAST_STEP)).toHaveText("Eraser");
});

test("Gradient drag draws a pending gradient, and Enter finishes it", async ({ page }) => {
  const center = await canvasCenter(page);
  await selectTool(page, "Gradient");
  await drag(page, [offset(center, -120, 0), offset(center, 120, 0)]);
  await expect(page.locator(LAST_STEP)).toHaveText("Gradient");
  await page.keyboard.press("Enter");
  await expect(page.locator(LAST_STEP)).toHaveText("Finish Gradient");
});

test("Line / Curve drag draws a line, and Enter finishes it", async ({ page }) => {
  const center = await canvasCenter(page);
  await selectTool(page, "Line / Curve");
  await drag(page, [offset(center, -120, -60), offset(center, 120, 60)]);
  await expect(page.locator(LAST_STEP)).toHaveText("Draw Line / Curve");
  await page.keyboard.press("Enter");
  await expect(page.locator(LAST_STEP)).toHaveText("Finish Line / Curve");
});

test("Shapes drag draws the default Rectangle, and Enter finishes it", async ({ page }) => {
  const center = await canvasCenter(page);
  await selectTool(page, "Shapes");
  await drag(page, [offset(center, -120, -80), offset(center, 120, 80)]);
  await expect(page.locator(LAST_STEP)).toHaveText("Draw Rectangle");
  await page.keyboard.press("Enter");
  await expect(page.locator(LAST_STEP)).toHaveText("Finish Rectangle");
});

test("a palette click recolors the pending shape live, recorded as one Change Color step (TL-FRAME-01)", async ({
  page,
}) => {
  const center = await canvasCenter(page);
  const clip = { x: center.x - 130, y: center.y - 90, width: 260, height: 180 };
  const steps = page.locator("ol.app-history-list li .app-history-name");
  await selectTool(page, "Shapes");
  await drag(page, [offset(center, -120, -80), offset(center, 120, 80)]);
  await expect(page.locator(LAST_STEP)).toHaveText("Draw Rectangle");
  const before = await steps.count();
  expect(await redPixels(page, clip)).toBe(0);
  // The third default swatch is pure red; a left click makes it the primary color.
  await page.locator(".color-palette-swatch").nth(2).click();
  await expect.poll(() => redPixels(page, clip)).toBeGreaterThan(200);
  await expect(page.locator(LAST_STEP)).toHaveText("Change Color");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Enter");
  await expect(page.locator(LAST_STEP)).toHaveText("Finish Rectangle");
  expect(await steps.count()).toBe(before + 2);
  expect(await redPixels(page, clip)).toBeGreaterThan(200);
});

test("a pending rectangle moves by its body and rotates from outside, then Enter finishes it (TL-SHAPE-01)", async ({
  page,
}) => {
  const center = await canvasCenter(page);
  const canvas = page.locator(ENGINE_CANVAS);
  const steps = page.locator("ol.app-history-list li .app-history-name");
  await selectTool(page, "Shapes");
  await drag(page, [offset(center, -120, -80), offset(center, 120, 80)]);
  await expect(page.locator(LAST_STEP)).toHaveText("Draw Rectangle");
  const before = await steps.count();

  // The body moves it: the four-way cursor shows, and the drag records one Adjust step.
  const body = offset(center, -90, -50);
  await page.mouse.move(body.x - 4, body.y);
  await page.mouse.move(body.x, body.y, { steps: 2 });
  await expect(canvas).toHaveCSS("cursor", "move");
  await drag(page, [body, offset(center, -60, -30)]);
  await expect(page.locator(LAST_STEP)).toHaveText("Adjust Rectangle");

  // Just outside the moved frame (its right edge is 150 px right of the old centre) it rotates;
  // with Shift a quarter turn about the moved centre snaps to 90 degrees.
  const moved = offset(center, 30, 20);
  const press = offset(center, 160, -20);
  await page.mouse.move(press.x - 2, press.y);
  await page.mouse.move(press.x, press.y, { steps: 2 });
  await expect(canvas).toHaveCSS("cursor", /data:image\/svg\+xml/);
  const quarter = { x: moved.x - (press.y - moved.y), y: moved.y + (press.x - moved.x) };
  await page.keyboard.down("Shift");
  await drag(page, [press, offset(quarter, 0, 0)]);
  await page.keyboard.up("Shift");
  await expect(page.locator(LAST_STEP)).toHaveText("Adjust Rectangle");
  await expect(page.locator(".app-status-bar")).toContainText("Angle: 90");

  await page.keyboard.press("Enter");
  await expect(page.locator(LAST_STEP)).toHaveText("Finish Rectangle");
  expect(await steps.count()).toBe(before + 3);
  // The 240 x 160 rectangle now stands 160 wide and 240 tall about the moved centre.
  await page.mouse.move(center.x + 400, center.y + 300);
  const clip = { x: moved.x - 160, y: moved.y - 160, width: 320, height: 320 };
  const bounds = await darkBounds(page, clip);
  const tolerance = 4;
  expect(Math.abs(bounds.right - bounds.left - 160)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(bounds.bottom - bounds.top - 240)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs((bounds.left + bounds.right) / 2 - 160)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs((bounds.top + bounds.bottom) / 2 - 160)).toBeLessThanOrEqual(tolerance);
});

test("Text places a caret, takes typed text, and Esc commits one Text step", async ({ page }) => {
  await selectTool(page, "Text");
  await click(page, await canvasCenter(page));
  // The tool takes the keyboard one tick after the click; a person can't type faster than that.
  await expect(page.getByRole("textbox", { name: "Text", exact: true })).toBeFocused();
  await page.keyboard.type("Hi");
  await page.keyboard.press("Escape");
  await expect(page.locator(LAST_STEP)).toHaveText("Text");
});

test("Clone Stamp copies from the Ctrl+click anchor and records one stroke", async ({ page }) => {
  const center = await canvasCenter(page);
  await selectTool(page, "Clone Stamp");
  await page.keyboard.down("Control");
  await click(page, offset(center, -100, 0));
  await page.keyboard.up("Control");
  await drag(page, [offset(center, 0, 0), offset(center, 60, 30)]);
  await expect(page.locator(LAST_STEP)).toHaveText("Clone Stamp");
});

test("Recolor drag records one stroke", async ({ page }) => {
  const center = await canvasCenter(page);
  await selectTool(page, "Recolor");
  await drag(page, [offset(center, -80, -40), offset(center, 80, 40)]);
  await expect(page.locator(LAST_STEP)).toHaveText("Recolor");
});

test("Color Picker records no history step", async ({ page }) => {
  const steps = page.locator("ol.app-history-list li");
  const before = await steps.count();
  await selectTool(page, "Color Picker");
  await click(page, await canvasCenter(page));
  await expect(steps).toHaveCount(before);
});

test("Zoom click zooms in one step", async ({ page }) => {
  const readout = page.locator(".app-status-zoom");
  const zoomOf = async () => Number.parseFloat((await readout.textContent()) ?? "");
  const before = await zoomOf();
  await selectTool(page, "Zoom");
  await click(page, await canvasCenter(page));
  await expect.poll(zoomOf).toBeGreaterThan(before);
});

test("Move Selected Pixels moves the selection contents and Enter finishes them", async ({
  page,
}) => {
  const center = await canvasCenter(page);
  await page.keyboard.press("Control+A");
  await selectTool(page, "Move Selected Pixels");
  // Away from the centre, where the rotation anchor of a Select All sits.
  await drag(page, [offset(center, -60, -40), offset(center, 0, -10)]);
  await expect(page.locator(LAST_STEP)).toHaveText("Move Pixels");
  await page.keyboard.press("Enter");
  await expect(page.locator(LAST_STEP)).toHaveText("Finish Pixels");
});

for (const engine of ["v1", "v2"]) {
  test(`Move Selected Pixels rotates the selection contents live, records Rotate Pixels and undoes it (engine ${engine})`, async ({
    page,
  }) => {
    if (engine === "v2") {
      await page.goto("/?engine=v2");
      await expect(page.locator(".app-status-zoom")).toHaveText(/\d+%/);
      await page.locator(".app-canvas-area").click({ position: { x: 4, y: 4 } });
      await page.keyboard.press("Control+B");
      await expect(page.locator(".app-status-zoom")).toHaveText("100%");
    }
    await rotatesSelectedPixels(page);
  });
}

/** A red block rotated a quarter turn with Move Selected Pixels: live, recorded, and undone. */
async function rotatesSelectedPixels(page: Page) {
  const center = await canvasCenter(page);
  const clip = { x: center.x - 200, y: center.y - 200, width: 400, height: 400 };
  const size = async () => {
    const bounds = await redBounds(page, clip);
    return { width: bounds.right - bounds.left, height: bounds.bottom - bounds.top };
  };
  // A red 240 x 80 block: the third default swatch is pure red.
  await page.locator(".color-palette-swatch").nth(2).click();
  await selectTool(page, "Rectangle Select");
  await drag(page, [offset(center, -120, -40), offset(center, 120, 40)]);
  await selectTool(page, "Paint Bucket");
  await click(page, center);
  await expect(page.locator(LAST_STEP)).toHaveText("Paint Bucket");
  await page.mouse.move(center.x + 400, center.y + 300);
  const before = await size();
  expect(before.width).toBeGreaterThan(200);
  expect(before.height).toBeLessThan(120);

  await selectTool(page, "Move Selected Pixels");
  // A right-button drag rotates about the anchor at the centre; with Shift a quarter turn snaps to
  // 90 degrees.
  const press = offset(center, 100, 0);
  await page.mouse.move(press.x, press.y);
  await page.keyboard.down("Shift");
  await page.mouse.down({ button: "right" });
  await page.mouse.move(center.x + 70, center.y + 70, { steps: 4 });
  await page.mouse.move(center.x, center.y + 100, { steps: 4 });
  // The preview shows the block standing upright while the button is still held.
  await expect.poll(async () => (await size()).height, { timeout: 10_000 }).toBeGreaterThan(200);
  expect((await size()).width).toBeLessThan(120);
  await page.mouse.up({ button: "right" });
  await page.keyboard.up("Shift");
  await expect(page.locator(LAST_STEP)).toHaveText("Rotate Pixels", { timeout: 15_000 });
  await page.mouse.move(center.x + 400, center.y + 300);
  const rotated = await size();
  expect(Math.abs(rotated.width - before.height)).toBeLessThanOrEqual(4);
  expect(Math.abs(rotated.height - before.width)).toBeLessThanOrEqual(4);

  await page.keyboard.press("Control+Z");
  await expect.poll(async () => (await size()).width, { timeout: 10_000 }).toBeGreaterThan(200);
  const undone = await size();
  expect(Math.abs(undone.width - before.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(undone.height - before.height)).toBeLessThanOrEqual(1);
}

test("Move Selected Pixels shows the move cursor over the selection (TL-MOVE-01)", async ({
  page,
}) => {
  const center = await canvasCenter(page);
  const canvas = page.locator(ENGINE_CANVAS);
  await selectTool(page, "Rectangle Select");
  await drag(page, [offset(center, -120, -80), offset(center, 120, 80)]);
  await expect(page.locator(LAST_STEP)).toHaveText("Rectangle Select");
  await selectTool(page, "Move Selected Pixels");
  const inside = offset(center, -60, -40);
  await page.mouse.move(inside.x - 5, inside.y);
  await page.mouse.move(inside.x, inside.y, { steps: 3 });
  await expect(canvas).toHaveCSS("cursor", "move");
  await page.mouse.move(center.x + 120, center.y + 80, { steps: 3 });
  await expect(canvas).toHaveCSS("cursor", "nwse-resize");
  const outside = offset(center, 0, 250);
  await page.mouse.move(outside.x, outside.y, { steps: 3 });
  await expect(canvas).not.toHaveCSS("cursor", "move");
});

test("Move Selection moves the outline and Enter finishes it", async ({ page }) => {
  const center = await canvasCenter(page);
  await page.keyboard.press("Control+A");
  await selectTool(page, "Move Selection");
  // Away from the centre, where the rotation anchor of a Select All sits.
  await drag(page, [offset(center, -60, -40), offset(center, 0, -10)]);
  await expect(page.locator(LAST_STEP)).toHaveText("Move Selection");
  await page.keyboard.press("Enter");
  await expect(page.locator(LAST_STEP)).toHaveText("Finish Selection");
});
