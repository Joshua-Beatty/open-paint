import { expect, type Page, test } from "@playwright/test";

/**
 * Painting never scrolls or pans the view when the pointer leaves the canvas (owner request): the
 * stroke follows the pointer over the sidebar and to the window edge, and the view stays put.
 */

const ENGINE_CANVAS = "[data-backend] canvas:not(.app-canvas-overlay)";

interface Layout {
  readonly zoom: number;
  readonly originX: number;
  readonly originY: number;
}

interface Bench {
  info(): { readonly layout?: Layout };
}

test.use({ viewport: { width: 1440, height: 900 } });

function layoutOf(page: Page): Promise<Layout | undefined> {
  return page.evaluate(
    () => (window as { __openpaintBench?: Bench }).__openpaintBench?.info().layout,
  );
}

/** The page's and every element's scroll offsets that are not zero, by element. */
function scrolled(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    if (window.scrollX !== 0 || window.scrollY !== 0) {
      found.push(`window ${window.scrollX},${window.scrollY}`);
    }
    for (const element of document.querySelectorAll("*")) {
      if (element.scrollLeft !== 0 || element.scrollTop !== 0) {
        found.push(`${element.className} ${element.scrollLeft},${element.scrollTop}`);
      }
    }
    return found;
  });
}

async function zoomIn(page: Page): Promise<void> {
  await page.goto("/?bench=1");
  await page.waitForFunction(
    () => (window as { __openpaintBench?: unknown }).__openpaintBench !== undefined,
  );
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.locator(".app-status-zoom")).toHaveText(/\d+%/);
  await page.locator(".app-canvas-area").focus();
  await page.keyboard.press("Control+0");
  await expect(page.locator(".app-status-zoom")).toHaveText("100%");
  for (let step = 0; step < 16; step++) {
    if ((await page.locator(".app-status-zoom").textContent()) === "400%") break;
    await page.keyboard.press("Control+Equal");
    await page.waitForTimeout(80);
  }
  await expect(page.locator(".app-status-zoom")).toHaveText("400%");
  await expect.poll(async () => (await layoutOf(page))?.zoom).toBeGreaterThan(3);
}

const AUTO_SCROLL_SETTING = "Auto-scroll when drawing at the edge of the window";

async function setAutoScroll(page: Page, on: boolean): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("option", { name: "User Interface" }).click();
  const box = dialog.getByRole("checkbox", { name: AUTO_SCROLL_SETTING });
  if ((await box.isChecked()) !== on) {
    await dialog.locator("label.react-aria-Checkbox", { hasText: AUTO_SCROLL_SETTING }).click();
  }
  await expect(box).toBeChecked({ checked: on });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
}

test("auto-scroll is off by default; turned on, it scrolls only while the pointer is at the canvas edge", async ({
  page,
}) => {
  await zoomIn(page);
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("option", { name: "User Interface" }).click();
  await expect(dialog.getByRole("checkbox", { name: AUTO_SCROLL_SETTING })).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await setAutoScroll(page, true);
  await page.getByRole("radio", { name: "Paintbrush", exact: true }).click();
  const box = await page.locator(ENGINE_CANVAS).boundingBox();
  if (box === null) throw new Error("the engine canvas has no box");
  const viewport = page.viewportSize() ?? { width: 1440, height: 900 };
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const before = await layoutOf(page);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  // Past the canvas, over the sidebar and at the window edge: the view stays.
  await page.mouse.move(viewport.width - 1, center.y, { steps: 20 });
  await page.waitForTimeout(300);
  expect((await layoutOf(page))?.originX).toBe(before?.originX);
  // Held just inside the canvas's right edge: the view scrolls toward it.
  await page.mouse.move(box.x + box.width - 2, center.y, { steps: 5 });
  await expect
    .poll(async () => (await layoutOf(page))?.originX ?? 0)
    .toBeLessThan(before?.originX ?? 0);
  await page.mouse.up();
  expect(await scrolled(page)).toEqual([]);
});

const TOOLS = [
  "Paintbrush",
  "Pencil",
  "Eraser",
  "Line / Curve",
  "Shapes",
  "Gradient",
  "Rectangle Select",
  "Lasso Select",
  "Move Selected Pixels",
  "Move Selection",
];

for (const tool of TOOLS) {
  test(`a ${tool} drag past the canvas to the window edge keeps the view still`, async ({
    page,
  }) => {
    await zoomIn(page);
    await page.getByRole("radio", { name: tool, exact: true }).click();
    const box = await page.locator(ENGINE_CANVAS).boundingBox();
    if (box === null) throw new Error("the engine canvas has no box");
    const before = await layoutOf(page);
    expect(await scrolled(page)).toEqual([]);
    const viewport = page.viewportSize() ?? { width: 1440, height: 900 };
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    // Past the right sidebar to the window edge, then around it, holding still at the edge.
    await page.mouse.move(viewport.width - 1, center.y, { steps: 20 });
    await page.waitForTimeout(300);
    await page.mouse.move(viewport.width - 1, viewport.height - 1, { steps: 10 });
    await page.mouse.move(viewport.width - 1, 1, { steps: 10 });
    await page.mouse.move(box.x + box.width - 2, box.y + 2, { steps: 10 });
    await page.waitForTimeout(300);
    expect(await scrolled(page)).toEqual([]);
    await page.mouse.up();
    await page.waitForTimeout(100);
    const after = await layoutOf(page);
    expect(after?.originX).toBe(before?.originX);
    expect(after?.originY).toBe(before?.originY);
    expect(after?.zoom).toBe(before?.zoom);
    expect(await scrolled(page)).toEqual([]);
  });
}
