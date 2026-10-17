import { expect, type Page, test } from "@playwright/test";

/**
 * Overlays (handles, frames, outlines) line up with what the engine draws at every display scale.
 * The overlays once sized themselves by `devicePixelRatio` while the engine canvas follows its
 * device-pixel box, and where the two disagree the handles drew at half or double scale.
 */

const ENGINE_CANVAS = "[data-backend] canvas:not(.app-canvas-overlay)";
const LAST_STEP = "ol.app-history-list li:last-child .app-history-name";

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The union of the drawn pixels of every overlay canvas, in CSS pixels of the page. */
async function overlayBounds(page: Page): Promise<Box | undefined> {
  return page.evaluate(() => {
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const canvas of document.querySelectorAll<HTMLCanvasElement>(
      "canvas.app-canvas-overlay",
    )) {
      const context = canvas.getContext("2d");
      if (context === null || canvas.width === 0 || canvas.height === 0) continue;
      const box = canvas.getBoundingClientRect();
      const sx = box.width / canvas.width;
      const sy = box.height / canvas.height;
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          if ((data[(y * canvas.width + x) * 4 + 3] ?? 0) === 0) continue;
          left = Math.min(left, box.left + x * sx);
          right = Math.max(right, box.left + (x + 1) * sx);
          top = Math.min(top, box.top + y * sy);
          bottom = Math.max(bottom, box.top + (y + 1) * sy);
        }
      }
    }
    if (right < left) return undefined;
    return { x: left, y: top, width: right - left, height: bottom - top };
  });
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

/** Expects the overlay's drawn bounds to be the drag's rectangle, give or take `slack` CSS px. */
async function expectBoundsAround(page: Page, rect: Box, slack: number) {
  await expect
    .poll(async () => {
      const bounds = await overlayBounds(page);
      if (bounds === undefined) return "nothing drawn";
      const off = Math.max(
        Math.abs(bounds.x - rect.x),
        Math.abs(bounds.y - rect.y),
        Math.abs(bounds.x + bounds.width - (rect.x + rect.width)),
        Math.abs(bounds.y + bounds.height - (rect.y + rect.height)),
      );
      return off <= slack ? "aligned" : `off by ${off.toFixed(1)} px: ${JSON.stringify(bounds)}`;
    })
    .toBe("aligned");
}

for (const scale of [1, 1.25, 1.5, 2]) {
  test.describe(`at device scale ${scale}`, () => {
    test.use({ deviceScaleFactor: scale, viewport: { width: 1280, height: 800 } });

    test("shape, line, selection and gradient handles sit on what they edit", async ({
      page,
      browserName,
    }) => {
      test.skip(browserName === "webkit", "WebKit emulates no device scale on Windows");
      await page.goto("/");
      await expect(page.getByRole("tab")).toHaveCount(1);
      const box = await page.locator(ENGINE_CANVAS).boundingBox();
      if (box === null) throw new Error("the engine canvas has no box");
      const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const a = { x: center.x - 120, y: center.y - 80 };
      const b = { x: center.x + 120, y: center.y + 80 };
      const rect = { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };

      // Shapes: the frame's corner handles (squares a few px across) are at the drag's corners.
      await page.getByRole("radio", { name: "Shapes", exact: true }).click();
      await drag(page, a, b);
      await expect(page.locator(LAST_STEP)).toHaveText("Draw Rectangle");
      await expectBoundsAround(page, rect, 8);
      // Dragging the corner handle resizes the shape (the handle is hit where it is drawn).
      await drag(page, b, { x: b.x + 40, y: b.y + 30 });
      await expect(page.locator(LAST_STEP)).toHaveText("Adjust Rectangle");
      await expectBoundsAround(
        page,
        { ...rect, width: rect.width + 40, height: rect.height + 30 },
        8,
      );
      await page.keyboard.press("Enter");

      // Line / Curve: the end nubs are at the line's ends.
      await page.getByRole("radio", { name: "Line / Curve", exact: true }).click();
      await drag(page, a, b);
      await expectBoundsAround(page, rect, 8);
      await page.keyboard.press("Enter");

      // Gradient: the start and end nubs.
      await page.getByRole("radio", { name: "Gradient", exact: true }).click();
      await drag(page, a, b);
      await expectBoundsAround(page, rect, 8);
      await page.keyboard.press("Enter");

      // Rectangle Select: the outline is the selection's edge.
      await page.getByRole("radio", { name: "Rectangle Select", exact: true }).click();
      await drag(page, a, b);
      await expect(page.locator(LAST_STEP)).toHaveText("Rectangle Select");
      await expectBoundsAround(page, rect, 3);
    });
  });
}
