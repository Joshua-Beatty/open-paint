import { expect, type Page, test } from "@playwright/test";

const ENGINE_CANVAS = "[data-backend] canvas:not(.app-canvas-overlay)";

/**
 * The mean chroma (largest minus smallest of R, G and B) of the canvas pixels in the left fifth of
 * the canvas, clear of a centered dialog, from a screenshot.
 */
async function leftChroma(page: Page): Promise<number> {
  const canvas = page.locator(ENGINE_CANVAS);
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("the engine canvas has no box");
  const png = await page.screenshot({
    clip: { x: box.x, y: box.y, width: Math.floor(box.width / 5), height: box.height },
  });
  return page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
    if (context === null) throw new Error("no 2D context");
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i] ?? 0;
      const g = pixels[i + 1] ?? 0;
      const b = pixels[i + 2] ?? 0;
      sum += Math.max(r, g, b) - Math.min(r, g, b);
    }
    return sum / (pixels.length / 4);
  }, png.toString("base64"));
}

async function idle(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__openpaintPerf !== undefined);
  const result = await page.evaluate(() => window.__openpaintPerf?.idle(30_000));
  expect(result?.idle).toBe(true);
}

for (const engine of ["v1", "v2"]) {
  test(`engine ${engine}: an adjustment's live preview shows on the canvas and OK keeps it (FX-FW-PREVIEW-01)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/?perf=1&bench=1&engine=${engine}`);
    await expect(page.getByRole("tab")).toHaveCount(1);
    // One layer of a half-transparent color.
    await page.waitForFunction(() => "__openpaintBench" in window);
    await page.evaluate(() =>
      (
        window as unknown as {
          __openpaintBench: { createDocument(options: object): unknown };
        }
      ).__openpaintBench.createDocument({ width: 800, height: 600, layers: 1, fill: true }),
    );
    await expect(page.getByRole("tab")).toHaveCount(2);
    await idle(page);
    const before = await leftChroma(page);
    expect(before).toBeGreaterThan(10);

    await page.getByRole("button", { name: "Adjustments", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Hue \/ Saturation/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("slider", { name: "Saturation", exact: true }).focus();
    await page.keyboard.press("Home");
    await idle(page);
    // The layer is unchanged while the canvas shows it without color.
    expect(await leftChroma(page)).toBeLessThan(2);

    await dialog.getByRole("button", { name: "OK", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("ol.app-history-list li:last-child .app-history-name")).toHaveText(
      "Hue / Saturation",
    );
    await idle(page);
    expect(await leftChroma(page)).toBeLessThan(2);

    await page.keyboard.press("Control+Z");
    await idle(page);
    expect(Math.abs((await leftChroma(page)) - before)).toBeLessThan(1);
  });
}

test("starts the engine and resolves a backend", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");

  const viewport = page.locator("[data-backend]");
  await expect(viewport).toHaveAttribute("data-backend", /^(webgpu|cpu)$/);
  const canvas = viewport.locator("canvas:not(.app-canvas-overlay)");
  await expect(canvas).toHaveCount(1);

  // Rendering owns the canvas now: a transferred canvas (worker) refuses a 2D context, and the
  // in-process fallback (WebKit, no OffscreenCanvas) holds a bitmap renderer, so it returns null.
  const transferred = await canvas.evaluate((el: HTMLCanvasElement) => {
    try {
      return el.getContext("2d") === null;
    } catch {
      return true;
    }
  });
  expect(transferred).toBe(true);
  expect(errors).toEqual([]);

  // The backend presents frames: the first-run image, which is white, shows at the canvas center.
  // (Firefox's WebGPU once refused every frame after the first, which left the canvas empty.)
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("the engine canvas has no box");
  const centerPixel = async () => {
    const png = await page.screenshot({
      clip: { x: box.x + box.width / 2 - 2, y: box.y + box.height / 2 - 2, width: 4, height: 4 },
    });
    return page.evaluate(async (data) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const context = document.createElement("canvas").getContext("2d");
      if (context === null) throw new Error("no 2D context");
      context.drawImage(bitmap, 0, 0);
      return [...context.getImageData(1, 1, 1, 1).data.slice(0, 3)];
    }, png.toString("base64"));
  };
  await expect.poll(centerPixel).toEqual([255, 255, 255]);
});

for (const engine of ["v1", "v2"]) {
  test(`engine ${engine}: a GPU canvas that cannot present falls back to the CPU and shows the image (WEB-GPU-05)`, async ({
    page,
  }) => {
    const logged: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") logged.push(message.text());
    });
    // The test hook makes every GPU present fail, as on a canvas that refuses its configuration.
    await page.goto(`/?engine=${engine}&gpu-fault=present`);
    const adapter = await page.evaluate(
      async () => (await navigator.gpu?.requestAdapter().catch(() => null)) != null,
    );
    test.skip(!adapter, "no WebGPU adapter: the CPU backend runs from the start");
    const viewport = page.locator("[data-backend]");
    await expect(viewport).toHaveAttribute("data-backend", "cpu");
    await expect(page.getByRole("status").filter({ hasText: "GPU acceleration" })).toHaveText(
      "GPU acceleration was turned off automatically after repeated GPU errors.",
    );
    expect(logged.some((text) => text.includes("gpu-fault test hook"))).toBe(true);

    // The first-run image, which is white, shows at the canvas center.
    const canvas = viewport.locator("canvas:not(.app-canvas-overlay)");
    await expect(canvas).toHaveCount(1);
    const box = await canvas.boundingBox();
    if (box === null) throw new Error("the engine canvas has no box");
    const centerPixel = async () => {
      const png = await page.screenshot({
        clip: { x: box.x + box.width / 2 - 2, y: box.y + box.height / 2 - 2, width: 4, height: 4 },
      });
      return page.evaluate(async (data) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const context = document.createElement("canvas").getContext("2d");
        if (context === null) throw new Error("no 2D context");
        context.drawImage(bitmap, 0, 0);
        return [...context.getImageData(1, 1, 1, 1).data.slice(0, 3)];
      }, png.toString("base64"));
    };
    await expect.poll(centerPixel).toEqual([255, 255, 255]);
  });
}
