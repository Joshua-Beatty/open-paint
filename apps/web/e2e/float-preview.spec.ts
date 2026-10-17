import { expect, type Page, test } from "@playwright/test";

/**
 * While Move Selected Pixels previews a transform, the canvas outside the moved content and the
 * area it left must show exactly what it showed before the drag: the preview must not change how
 * the rest of the image is sampled, filtered or placed (TL-MOVE-PIX-01).
 */

const ENGINE_CANVAS = "[data-backend] canvas:not(.app-canvas-overlay)";
const LAST_STEP = "ol.app-history-list li:last-child .app-history-name";
/** Hides the overlays (frame, handles, selection outline): only the engine's pixels count. */
const CANVAS_ONLY = ".app-canvas-overlay { visibility: hidden !important; }";

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function idle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const perf = (window as { __openpaintPerf?: { idle(ms: number): Promise<unknown> } })
      .__openpaintPerf;
    await perf?.idle(60_000);
  });
}

async function canvasBox(page: Page): Promise<Box> {
  const box = await page.locator(ENGINE_CANVAS).boundingBox();
  if (box === null) throw new Error("The engine canvas has no box.");
  return box;
}

/** The engine canvas's pixels as the page shows them, and the screenshot's pixels per CSS px. */
async function canvasPixels(page: Page, clip: Box) {
  const png = await page.screenshot({ clip, style: CANVAS_ONLY });
  return page.evaluate(
    async ({ data, cssWidth }) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
      if (context === null) throw new Error("no 2D context");
      context.drawImage(bitmap, 0, 0);
      const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
      return {
        width: image.width,
        height: image.height,
        scale: image.width / cssWidth,
        data: Array.from(image.data),
      };
    },
    { data: png.toString("base64"), cssWidth: clip.width },
  );
}

/**
 * The pixels that differ between two screenshots of `clip`, outside `keep` (CSS px of the page,
 * grown by `margin`), and where the first one lies.
 */
function differences(
  before: Awaited<ReturnType<typeof canvasPixels>>,
  after: Awaited<ReturnType<typeof canvasPixels>>,
  clip: Box,
  keep: readonly Box[],
  margin: number,
) {
  let count = 0;
  let first: { x: number; y: number } | undefined;
  let farthest = 0;
  for (let y = 0; y < before.height; y++) {
    for (let x = 0; x < before.width; x++) {
      const px = clip.x + (x + 0.5) / before.scale;
      const py = clip.y + (y + 0.5) / before.scale;
      const kept = keep.some(
        (box) =>
          px >= box.x - margin &&
          px < box.x + box.width + margin &&
          py >= box.y - margin &&
          py < box.y + box.height + margin,
      );
      if (kept) continue;
      const i = (y * before.width + x) * 4;
      if (
        before.data[i] !== after.data[i] ||
        before.data[i + 1] !== after.data[i + 1] ||
        before.data[i + 2] !== after.data[i + 2]
      ) {
        count++;
        first ??= { x: Math.round(px), y: Math.round(py) };
        const distance = Math.min(
          ...keep.map((box) =>
            Math.max(box.x - px, px - box.x - box.width, box.y - py, py - box.y - box.height),
          ),
        );
        farthest = Math.max(farthest, distance);
      }
    }
  }
  return { count, first, farthest };
}

/** A 4000 x 3000 image of noise, so any change of sampling or filtering shows. */
async function noisyImage(page: Page, engine: string) {
  await page.goto(`/?perf=1&bench=1${engine === "v2" ? "&engine=v2" : ""}`);
  await page.waitForFunction(
    () => (window as { __openpaintBench?: unknown }).__openpaintBench !== undefined,
  );
  await expect(page.locator(".app-status-zoom")).toHaveText(/\d+%/);
  await page.evaluate(() =>
    (
      window as {
        __openpaintBench?: { createDocument(options: object): unknown };
      }
    ).__openpaintBench?.createDocument({ width: 4000, height: 3000, layers: 1, fill: true }),
  );
  await expect(page.getByRole("tab")).toHaveCount(2);
  await idle(page);
  await page.getByRole("button", { name: "Effects", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Noise/ }).click();
  await page.getByRole("menuitem", { name: /^Add Noise/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await idle(page);
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.locator(LAST_STEP)).toHaveText("Add Noise");
  await idle(page);
}

async function zoomTo(page: Page, zoom: "fit" | "100" | "200") {
  await page.locator(".app-canvas-area").focus();
  if (zoom !== "fit") {
    await page.keyboard.press("Control+0");
    await expect(page.locator(".app-status-zoom")).toHaveText("100%");
  }
  if (zoom === "200") {
    // Zoom In steps through the presets (150 %, then 200 %).
    for (let step = 0; step < 4; step++) {
      if ((await page.locator(".app-status-zoom").textContent()) === "200%") break;
      await page.keyboard.press("Control+Equal");
      await page.waitForTimeout(100);
    }
    await expect(page.locator(".app-status-zoom")).toHaveText("200%");
  }
  await idle(page);
  // Rebuilt mips settle into their final filter once edits pause.
  await page.waitForTimeout(400);
  await idle(page);
}

test.use({ viewport: { width: 1440, height: 900 } });

for (const scale of [1, 2]) {
  test.describe(`at ${scale} device pixels per CSS pixel`, () => {
    test.use({ deviceScaleFactor: scale });
    for (const engine of ["v1", "v2"]) {
      for (const zoom of ["fit", "100", "200"] as const) {
        defineCase(scale, engine, zoom);
      }
    }
  });
}

function defineCase(scale: number, engine: string, zoom: "fit" | "100" | "200") {
  test(`the canvas outside a rotated selection is unchanged during the drag (engine ${engine}, ${zoom}, scale ${scale})`, async ({
    page,
    browserName,
  }) => {
    // Only Chromium takes a device scale factor; desktop Firefox runs at the screen's own.
    test.skip(scale !== 1 && browserName !== "chromium", "Chromium only");
    test.setTimeout(120_000);
    await noisyImage(page, engine);
    // The preview this checks is the GPU's; on the CPU backend each frame writes the layer.
    const backend = await page.locator("[data-backend]").getAttribute("data-backend");
    test.skip(backend !== "webgpu", "needs WebGPU");
    await zoomTo(page, zoom);
    const box = await canvasBox(page);
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const half = { width: 110, height: 50 };
    const selection: Box = {
      x: center.x - half.width,
      y: center.y - half.height,
      width: 2 * half.width,
      height: 2 * half.height,
    };
    await page.getByRole("radio", { name: "Rectangle Select", exact: true }).click();
    await page.mouse.move(selection.x, selection.y);
    await page.mouse.down();
    await page.mouse.move(selection.x + selection.width, selection.y + selection.height, {
      steps: 4,
    });
    await page.mouse.up();
    await page.getByRole("radio", { name: "Move Selected Pixels", exact: true }).click();
    await idle(page);
    await page.mouse.move(box.x + 4, box.y + 4);
    await page.waitForTimeout(200);
    const before = await canvasPixels(page, box);

    // A right-button drag rotates about the centre; Shift snaps it to a quarter turn.
    await page.mouse.move(center.x + 90, center.y);
    await page.keyboard.down("Shift");
    await page.mouse.down({ button: "right" });
    await page.mouse.move(center.x + 64, center.y + 64, { steps: 3 });
    await page.mouse.move(center.x, center.y + 90, { steps: 3 });
    await idle(page);
    await page.waitForTimeout(300);
    const during = await canvasPixels(page, box);
    await page.mouse.up({ button: "right" });
    await page.keyboard.up("Shift");
    await expect(page.locator(LAST_STEP)).toHaveText("Rotate Pixels", { timeout: 60_000 });

    // The moved content and the area it left, with room for the display's filter support.
    const rotated: Box = {
      x: center.x - half.height,
      y: center.y - half.width,
      width: 2 * half.height,
      height: 2 * half.width,
    };
    // A change spreads through the mip filter (Lanczos-3) by a few screen pixels when zoomed out,
    // as it does in the recorded result; zoomed in, the selection snaps to whole image pixels.
    const margin = zoom === "fit" ? 8 : 4;
    const diff = differences(before, during, box, [selection, rotated], margin);
    // The preview moved something: inside the footprint the pixels changed.
    const inside = differences(before, during, box, [], 0);
    expect(inside.count).toBeGreaterThan(0);
    expect(diff, `first difference at ${JSON.stringify(diff.first)}`).toEqual({
      count: 0,
      first: undefined,
      farthest: 0,
    });

    // The preview shows what the recorded step shows once the display has settled.
    await idle(page);
    await page.mouse.move(box.x + 4, box.y + 4);
    await page.waitForTimeout(400);
    await idle(page);
    const after = await canvasPixels(page, box);
    expect(largestDifference(during, after)).toBeLessThanOrEqual(1);
  });
}

/** The largest difference of any color channel between two screenshots of the same clip. */
function largestDifference(
  a: Awaited<ReturnType<typeof canvasPixels>>,
  b: Awaited<ReturnType<typeof canvasPixels>>,
): number {
  let largest = 0;
  for (let i = 0; i < a.data.length; i++) {
    if (i % 4 === 3) continue;
    largest = Math.max(largest, Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)));
  }
  return largest;
}

async function selectRect(page: Page, area: Box): Promise<void> {
  await page.getByRole("radio", { name: "Rectangle Select", exact: true }).click();
  await page.mouse.move(area.x, area.y);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width, area.y + area.height, { steps: 4 });
  await page.mouse.up();
}

for (const engine of ["v1", "v2"]) {
  test(`a drag started right after a commit shows the committed image around it (engine ${engine})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await noisyImage(page, engine);
    const backend = await page.locator("[data-backend]").getAttribute("data-backend");
    test.skip(backend !== "webgpu", "needs WebGPU");
    await zoomTo(page, "fit");
    const box = await canvasBox(page);
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    // The whole image moves first, so every display tile is rebuilt after its commit.
    await page.getByRole("radio", { name: "Move Selected Pixels", exact: true }).click();
    await page.locator(".app-canvas-area").focus();
    await page.keyboard.press("Control+A");
    // Off the centre, where the rotation anchor sits.
    await page.mouse.move(center.x - 200, center.y - 100);
    await page.mouse.down();
    await page.mouse.move(center.x - 120, center.y - 100, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.press("Enter");

    // Straight away, before the display has rebuilt the tiles under the first move.
    const second: Box = { x: center.x + 60, y: center.y - 40, width: 160, height: 100 };
    await selectRect(page, second);
    await page.getByRole("radio", { name: "Move Selected Pixels", exact: true }).click();
    await page.mouse.move(second.x + 40, second.y + 30);
    await page.mouse.down();
    await page.mouse.move(second.x + 40, second.y + 90, { steps: 4 });
    await idle(page);
    await page.waitForTimeout(300);
    const during = await canvasPixels(page, box);
    await page.mouse.up();
    await expect(page.locator(LAST_STEP)).toHaveText("Move Pixels");

    // The image as the first move left it, once the display has settled.
    await page.locator(".app-canvas-area").focus();
    await page.keyboard.press("Control+Z");
    await expect(page.locator("ol.app-history-list li.is-undone")).toHaveCount(1);
    await page.mouse.move(box.x + 4, box.y + 4);
    await idle(page);
    await page.waitForTimeout(400);
    await idle(page);
    const committed = await canvasPixels(page, box);
    const moved: Box = { ...second, y: second.y + 60 };
    const diff = differences(committed, during, box, [second, moved], 8);
    expect(diff, `first difference at ${JSON.stringify(diff.first)}`).toEqual({
      count: 0,
      first: undefined,
      farthest: 0,
    });
  });

  test(`Move Selection leaves every canvas pixel as it is during the drag (engine ${engine})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await noisyImage(page, engine);
    await zoomTo(page, "fit");
    const box = await canvasBox(page);
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.getByRole("radio", { name: "Rectangle Select", exact: true }).click();
    await page.mouse.move(center.x - 110, center.y - 50);
    await page.mouse.down();
    await page.mouse.move(center.x + 110, center.y + 50, { steps: 4 });
    await page.mouse.up();
    await page.getByRole("radio", { name: "Move Selection", exact: true }).click();
    await idle(page);
    await page.mouse.move(box.x + 4, box.y + 4);
    await page.waitForTimeout(200);
    const before = await canvasPixels(page, box);
    await page.mouse.move(center.x - 60, center.y - 20);
    await page.mouse.down();
    await page.mouse.move(center.x + 40, center.y + 30, { steps: 6 });
    await idle(page);
    await page.waitForTimeout(300);
    const during = await canvasPixels(page, box);
    await page.mouse.up();
    await expect(page.locator(LAST_STEP)).toHaveText("Move Selection");
    expect(differences(before, during, box, [], 0).count).toBe(0);
  });
}
