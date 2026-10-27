import { expect, type Page, test } from "@playwright/test";

/**
 * Selections are pixel based (owner request): the move tools' handles sit on pixel corners and
 * jump pixel by pixel when zoomed in, and the Lasso's outline runs between pixel corners.
 */

const ENGINE_CANVAS = "[data-backend] canvas:not(.app-canvas-overlay)";
const LAST_STEP = "ol.app-history-list li:last-child .app-history-name";

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Bench {
  info(): {
    readonly devicePixelRatio: number;
    readonly layout?: { readonly zoom: number; readonly originX: number; readonly originY: number };
  };
  selection(): number[][];
}

test.use({ viewport: { width: 1440, height: 900 } });

async function open(page: Page): Promise<void> {
  await page.goto("/?bench=1");
  await page.waitForFunction(
    () => (window as { __openpaintBench?: unknown }).__openpaintBench !== undefined,
  );
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.getByRole("radio").first()).toBeVisible();
  await expect(page.locator(".app-status-zoom")).toHaveText(/\d+%/);
}

async function zoomTo800(page: Page): Promise<void> {
  await page.locator(".app-canvas-area").focus();
  await page.keyboard.press("Control+0");
  await expect(page.locator(".app-status-zoom")).toHaveText("100%");
  for (let step = 0; step < 16; step++) {
    if ((await page.locator(".app-status-zoom").textContent()) === "800%") break;
    await page.keyboard.press("Control+Equal");
    await page.waitForTimeout(80);
  }
  await expect(page.locator(".app-status-zoom")).toHaveText("800%");
}

/** Maps image pixels to page CSS pixels and back, from the engine's view layout. */
async function view(page: Page) {
  const box = await page.locator(ENGINE_CANVAS).boundingBox();
  if (box === null) throw new Error("the engine canvas has no box");
  await expect
    .poll(() =>
      page.evaluate(() => (window as { __openpaintBench?: Bench }).__openpaintBench?.info().layout),
    )
    .toBeDefined();
  const info = await page.evaluate(
    () =>
      (window as { __openpaintBench?: Bench }).__openpaintBench?.info() as ReturnType<
        Bench["info"]
      >,
  );
  const layout = info.layout;
  if (layout === undefined) throw new Error("no layout");
  const dpr = info.devicePixelRatio;
  const scale = layout.zoom / dpr;
  const origin = { x: box.x + layout.originX / dpr, y: box.y + layout.originY / dpr };
  return {
    scale,
    origin,
    toPage: (p: Point): Point => ({ x: origin.x + p.x * scale, y: origin.y + p.y * scale }),
    toImage: (p: Point): Point => ({ x: (p.x - origin.x) / scale, y: (p.y - origin.y) / scale }),
    center: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  };
}

function selectionOf(page: Page): Promise<number[][]> {
  return page.evaluate(
    () => (window as { __openpaintBench?: Bench }).__openpaintBench?.selection() ?? [],
  );
}

/** The centre of what the frame overlay draws within `radius` CSS pixels of `p`. */
async function drawnCenter(page: Page, p: Point, radius: number): Promise<Point | undefined> {
  return page.evaluate(
    ({ p, radius }) => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        'canvas[data-overlay="transform-frame"]',
      );
      const context = canvas?.getContext("2d");
      if (canvas == null || context == null || canvas.width === 0) return undefined;
      const rect = canvas.getBoundingClientRect();
      const sx = canvas.width / rect.width;
      const sy = canvas.height / rect.height;
      const x0 = Math.max(0, Math.floor((p.x - radius - rect.left) * sx));
      const y0 = Math.max(0, Math.floor((p.y - radius - rect.top) * sy));
      const x1 = Math.min(canvas.width, Math.ceil((p.x + radius - rect.left) * sx));
      const y1 = Math.min(canvas.height, Math.ceil((p.y + radius - rect.top) * sy));
      if (x1 <= x0 || y1 <= y0) return undefined;
      const data = context.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let left = Number.POSITIVE_INFINITY;
      let top = Number.POSITIVE_INFINITY;
      let right = Number.NEGATIVE_INFINITY;
      let bottom = Number.NEGATIVE_INFINITY;
      for (let y = 0; y < y1 - y0; y++) {
        for (let x = 0; x < x1 - x0; x++) {
          if ((data[(y * (x1 - x0) + x) * 4 + 3] ?? 0) < 128) continue;
          left = Math.min(left, x0 + x);
          right = Math.max(right, x0 + x + 1);
          top = Math.min(top, y0 + y);
          bottom = Math.max(bottom, y0 + y + 1);
        }
      }
      if (right < left) return undefined;
      return { x: rect.left + (left + right) / 2 / sx, y: rect.top + (top + bottom) / 2 / sy };
    },
    { p, radius },
  );
}

test("at 800 %, a dragged selection corner moves in whole image pixels, its handle on pixel corners", async ({
  page,
}) => {
  await open(page);
  await zoomTo800(page);
  const v = await view(page);
  expect(v.scale).toBeCloseTo(8, 6);
  // A 10 x 8 pixel rectangle around the middle of the view.
  const middle = v.toImage(v.center);
  const from = { x: Math.floor(middle.x) - 5, y: Math.floor(middle.y) - 4 };
  await page.getByRole("radio", { name: "Rectangle Select", exact: true }).click();
  const press = v.toPage({ x: from.x + 0.5, y: from.y + 0.5 });
  const release = v.toPage({ x: from.x + 9.5, y: from.y + 7.5 });
  await page.mouse.move(press.x, press.y);
  await page.mouse.down();
  await page.mouse.move(release.x, release.y, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(LAST_STEP)).toHaveText("Rectangle Select");

  await page.getByRole("radio", { name: "Move Selection", exact: true }).click();
  const corner = { x: from.x + 10, y: from.y + 8 };
  const exact = v.toPage(corner);
  await expect.poll(() => drawnCenter(page, exact, 8)).toBeDefined();
  // A little off the corner, so no step lands the pointer exactly between two pixel corners.
  const start = { x: exact.x + 0.3, y: exact.y + 0.3 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const seen = new Set<number>();
  for (let i = 1; i <= 16; i++) {
    const at = { x: start.x + i * 3.5, y: start.y + i * 1.75 };
    await page.mouse.move(at.x, at.y);
    // The handle is drawn at the pixel corner nearest the pointer.
    const expected = { x: Math.round(v.toImage(at).x), y: Math.round(v.toImage(at).y) };
    if (i * 3.5 > 4) {
      // The outline's right edge follows the handle, on a whole pixel.
      await expect
        .poll(async () => {
          const ring = (await selectionOf(page))[0] ?? [];
          return Math.max(...ring.filter((_, k) => k % 2 === 0));
        })
        .toBe(expected.x);
      expect((await selectionOf(page)).flat().every((value) => Number.isInteger(value))).toBe(true);
      const handle = await drawnCenter(page, v.toPage(expected), 6);
      if (handle === undefined) throw new Error(`no handle drawn at step ${i}`);
      // Its screen position is a whole number of zoom steps from the image's origin.
      const image = v.toImage(handle);
      expect(Math.abs(image.x - expected.x)).toBeLessThan(0.2);
      expect(Math.abs(image.y - expected.y)).toBeLessThan(0.2);
      seen.add(expected.x);
    }
  }
  await page.mouse.up();
  await expect(page.locator(LAST_STEP)).toHaveText("Resize Selection");
  // 56 CSS px at 8 per image pixel: the corner went through the whole pixels on its way.
  expect(seen.size).toBeGreaterThanOrEqual(6);
  const rings = await selectionOf(page);
  expect(rings).toHaveLength(1);
  expect(rings[0]?.every((value) => Number.isInteger(value))).toBe(true);
});

/** The ring's vertices, sorted so two rings compare whatever vertex they start at. */
function sortedVertices(ring: readonly number[]): [number, number][] {
  const points: [number, number][] = [];
  for (let i = 0; i + 1 < ring.length; i += 2) points.push([ring[i] ?? 0, ring[i + 1] ?? 0]);
  return points.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}

test("a rotation keeps the exact outline, and a later move shifts it by whole pixels", async ({
  page,
}) => {
  await open(page);
  await zoomTo800(page);
  const v = await view(page);
  const middle = v.toImage(v.center);
  const from = { x: Math.floor(middle.x) - 5, y: Math.floor(middle.y) - 4 };
  await page.getByRole("radio", { name: "Rectangle Select", exact: true }).click();
  const press = v.toPage({ x: from.x + 0.5, y: from.y + 0.5 });
  const release = v.toPage({ x: from.x + 9.5, y: from.y + 7.5 });
  await page.mouse.move(press.x, press.y);
  await page.mouse.down();
  await page.mouse.move(release.x, release.y, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(LAST_STEP)).toHaveText("Rectangle Select");

  await page.getByRole("radio", { name: "Move Selection", exact: true }).click();
  const pivot = v.toPage({ x: from.x + 5, y: from.y + 4 });
  // A right-button drag turns the frame by about 20 degrees about its centre.
  const arc = (degrees: number) => ({
    x: pivot.x + 120 * Math.cos((degrees * Math.PI) / 180),
    y: pivot.y + 120 * Math.sin((degrees * Math.PI) / 180),
  });
  await page.mouse.move(arc(0).x, arc(0).y);
  await page.mouse.down({ button: "right" });
  for (let d = 2; d <= 20; d += 2) await page.mouse.move(arc(d).x, arc(d).y);
  await page.mouse.up({ button: "right" });
  await expect(page.locator(LAST_STEP)).toHaveText("Rotate Selection");
  const turned = (await selectionOf(page))[0] ?? [];
  expect(turned).toHaveLength(8);
  expect(turned.some((value) => !Number.isInteger(value))).toBe(true);
  // A rotation keeps the shape: the 10 x 8 rectangle's area and side lengths.
  const points = sortedVertices(turned);
  let area = 0;
  for (let i = 0; i < turned.length; i += 2) {
    const j = (i + 2) % turned.length;
    area += (turned[i] ?? 0) * (turned[j + 1] ?? 0) - (turned[j] ?? 0) * (turned[i + 1] ?? 0);
  }
  expect(Math.abs(area) / 2).toBeCloseTo(80, 1);
  expect(points).toHaveLength(4);

  // A body drag of 27 x 13 CSS px at 800 % moves it by whole pixels: 3 right, 2 down.
  const grab = { x: pivot.x - 20, y: pivot.y + 12 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 27, grab.y + 13, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(LAST_STEP)).toHaveText("Move Selection");
  const moved = sortedVertices((await selectionOf(page))[0] ?? []);
  expect(moved).toHaveLength(4);
  moved.forEach(([x, y], i) => {
    expect(x - (points[i]?.[0] ?? 0)).toBeCloseTo(3, 6);
    expect(y - (points[i]?.[1] ?? 0)).toBeCloseTo(2, 6);
  });
});

for (const zoom of ["100", "800"] as const) {
  test(`a freehand Lasso outline has every vertex on a pixel corner (${zoom} %)`, async ({
    page,
  }) => {
    await open(page);
    if (zoom === "800") await zoomTo800(page);
    else {
      await page.locator(".app-canvas-area").focus();
      await page.keyboard.press("Control+0");
      await expect(page.locator(".app-status-zoom")).toHaveText("100%");
    }
    const v = await view(page);
    await page.getByRole("radio", { name: "Lasso Select", exact: true }).click();
    const radius = 180;
    const points: Point[] = [];
    for (let i = 0; i <= 60; i++) {
      const t = (i / 60) * 2 * Math.PI;
      const wobble = 1 + 0.15 * Math.sin(5 * t);
      points.push({
        x: v.center.x + radius * wobble * Math.cos(t),
        y: v.center.y + radius * 0.7 * wobble * Math.sin(t) + 0.37,
      });
    }
    const [first, ...rest] = points;
    if (first === undefined) throw new Error("no path");
    await page.mouse.move(first.x, first.y);
    await page.mouse.down();
    for (const p of rest) await page.mouse.move(p.x, p.y, { steps: 3 });
    await page.mouse.up();
    await expect(page.locator(LAST_STEP)).toHaveText("Lasso Select");
    const rings = await selectionOf(page);
    expect(rings.length).toBeGreaterThan(0);
    let slanted = 0;
    for (const ring of rings) {
      expect(ring.every((value) => Number.isInteger(value))).toBe(true);
      const n = ring.length / 2;
      for (let k = 0; k < n; k++) {
        const dx = (ring[((k + 1) % n) * 2] ?? 0) - (ring[k * 2] ?? 0);
        const dy = (ring[((k + 1) % n) * 2 + 1] ?? 0) - (ring[k * 2 + 1] ?? 0);
        expect(dx !== 0 || dy !== 0).toBe(true);
        if (dx !== 0 && dy !== 0 && Math.abs(dx) !== Math.abs(dy)) slanted++;
      }
    }
    // Edges between corners at slopes other than flat, upright or 45 degrees.
    expect(slanted).toBeGreaterThan(0);
  });
}
