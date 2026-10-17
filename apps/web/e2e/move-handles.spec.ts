import { expect, type Page, test } from "@playwright/test";

/**
 * The move tools show the selection's handles as soon as they are active, before any press, and a
 * drag on a handle scales the selection at once (owner request).
 */

const ENGINE_CANVAS = "[data-backend] canvas:not(.app-canvas-overlay)";
const LAST_STEP = "ol.app-history-list li:last-child .app-history-name";

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

test.use({ viewport: { width: 1440, height: 900 } });

/** The drawn pixels of one overlay inside `box` (or the whole overlay), in CSS pixels of the page. */
async function drawnBounds(page: Page, overlay: string, box?: Box): Promise<Box | undefined> {
  return page.evaluate(
    ({ overlay, box }) => {
      const canvas = document.querySelector<HTMLCanvasElement>(`canvas[data-overlay="${overlay}"]`);
      const context = canvas?.getContext("2d");
      if (canvas == null || context == null || canvas.width === 0) return undefined;
      const rect = canvas.getBoundingClientRect();
      const sx = canvas.width / rect.width;
      const sy = canvas.height / rect.height;
      const x0 = box === undefined ? 0 : Math.max(0, Math.floor((box.left - rect.left) * sx));
      const y0 = box === undefined ? 0 : Math.max(0, Math.floor((box.top - rect.top) * sy));
      const x1 =
        box === undefined
          ? canvas.width
          : Math.min(canvas.width, Math.ceil((box.right - rect.left) * sx));
      const y1 =
        box === undefined
          ? canvas.height
          : Math.min(canvas.height, Math.ceil((box.bottom - rect.top) * sy));
      if (x1 <= x0 || y1 <= y0) return undefined;
      const data = context.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let left = Number.POSITIVE_INFINITY;
      let top = Number.POSITIVE_INFINITY;
      let right = Number.NEGATIVE_INFINITY;
      let bottom = Number.NEGATIVE_INFINITY;
      for (let y = 0; y < y1 - y0; y++) {
        for (let x = 0; x < x1 - x0; x++) {
          if ((data[(y * (x1 - x0) + x) * 4 + 3] ?? 0) === 0) continue;
          left = Math.min(left, rect.left + (x0 + x) / sx);
          right = Math.max(right, rect.left + (x0 + x + 1) / sx);
          top = Math.min(top, rect.top + (y0 + y) / sy);
          bottom = Math.max(bottom, rect.top + (y0 + y + 1) / sy);
        }
      }
      return right < left ? undefined : { left, top, right, bottom };
    },
    { overlay, box },
  );
}

/** A square of `radius` CSS pixels around `p`. */
function around(p: Point, radius: number): Box {
  return { left: p.x - radius, top: p.y - radius, right: p.x + radius, bottom: p.y + radius };
}

async function setup(page: Page, zoom: "100" | "fit") {
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.getByRole("radio").first()).toBeVisible();
  await expect(page.locator(".app-status-zoom")).toHaveText(/\d+%/);
  if (zoom === "100") {
    await page.locator(".app-canvas-area").click({ position: { x: 4, y: 4 } });
    // From Zoom to Window to Actual Size.
    await page.keyboard.press("Control+B");
    await expect(page.locator(".app-status-zoom")).toHaveText("100%");
  }
}

for (const zoom of ["100", "fit"] as const) {
  for (const tool of [
    { name: "Move Selected Pixels", step: "Resize Pixels" },
    { name: "Move Selection", step: "Resize Selection" },
  ]) {
    test(`${tool.name} shows the selection's handles before any press, and a corner drag resizes it (${zoom})`, async ({
      page,
    }) => {
      await setup(page, zoom);
      const box = await page.locator(ENGINE_CANVAS).boundingBox();
      if (box === null) throw new Error("the engine canvas has no box");
      const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await page.getByRole("radio", { name: "Rectangle Select", exact: true }).click();
      await page.mouse.move(center.x - 120, center.y - 80);
      await page.mouse.down();
      await page.mouse.move(center.x + 120, center.y + 80, { steps: 6 });
      await page.mouse.up();
      await expect(page.locator(LAST_STEP)).toHaveText("Rectangle Select");
      const steps = page.locator("ol.app-history-list li");
      const before = await steps.count();
      const selected = await drawnBounds(page, "selection");
      if (selected === undefined) throw new Error("no selection drawn");
      const corner = { x: selected.right, y: selected.bottom };
      // No frame while a selection tool is active.
      expect(await drawnBounds(page, "transform-frame")).toBeUndefined();

      await page.getByRole("radio", { name: tool.name, exact: true }).click();
      // The corner's handle square is drawn without a press, and nothing was recorded.
      await expect
        .poll(() => drawnBounds(page, "transform-frame", around(corner, 5)))
        .toBeDefined();
      await expect(steps).toHaveCount(before);

      // Hovering the corner shows a resize arrow before any click.
      const canvas = page.locator(ENGINE_CANVAS);
      await page.mouse.move(corner.x - 6, corner.y - 6);
      await page.mouse.move(corner.x, corner.y, { steps: 2 });
      await expect(canvas).toHaveCSS("cursor", "nwse-resize");

      // Dragging it resizes at once; the ants follow the selection during the drag.
      await page.mouse.down();
      await page.mouse.move(corner.x + 40, corner.y + 30, { steps: 6 });
      await expect
        .poll(async () => {
          const during = await drawnBounds(page, "selection");
          return during === undefined ? 0 : during.right - selected.right;
        })
        .toBeGreaterThan(30);
      await page.mouse.up();
      await expect(page.locator(LAST_STEP)).toHaveText(tool.step);
      await expect(steps).toHaveCount(before + 1);
      const grown = await drawnBounds(page, "selection");
      if (grown === undefined) throw new Error("no selection drawn");
      expect(grown.right - selected.right).toBeGreaterThan(30);
      expect(grown.bottom - selected.bottom).toBeGreaterThan(20);
      expect(Math.abs(grown.left - selected.left)).toBeLessThanOrEqual(2);
      // The handles follow the resized selection.
      await expect
        .poll(() =>
          drawnBounds(page, "transform-frame", around({ x: grown.right, y: grown.bottom }, 5)),
        )
        .toBeDefined();
    });
  }
}
