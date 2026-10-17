import { expect, type Page, test } from "@playwright/test";
import { bundledFontFiles } from "../src/text/font-manifest";

/** The font files in any of the app's caches, by path, each once. */
function cachedFontFiles(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const paths = new Set<string>();
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) {
        const path = new URL(request.url).pathname;
        if (/\.(?:woff2|otf|ttf)$/.test(path)) paths.add(path);
      }
    }
    return [...paths];
  });
}

/** The engine canvas, without the overlays that sit on top of it. */
const ENGINE_CANVAS = "[data-backend] canvas:not(.app-canvas-overlay)";

test("runs fully offline after the first load (WEB-ENV-03)", async ({ page, context }) => {
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  // The worker precaches the shell on install. A reload puts this page under its control.
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

  const precache = await page.evaluate(async () => {
    const names = (await caches.keys()).filter((name) => name.includes("-precache-"));
    const paths: string[] = [];
    for (const name of names) {
      for (const request of await (await caches.open(name)).keys()) {
        paths.push(new URL(request.url).pathname);
      }
    }
    return { names, paths };
  });
  // One precache per app version (08 SET-LIFE-01).
  expect(precache.names).toHaveLength(1);
  expect(precache.names[0]).toMatch(/^openpaint-/);
  // The app shell, the codec WASM and the default font are installed; other fonts wait for first use.
  const wasm = precache.paths.find((path) => path.endsWith(".wasm"));
  if (wasm === undefined) throw new Error("No codec WASM is precached.");
  const fonts = precache.paths.filter((path) => path.endsWith(".woff2"));
  expect(fonts.length).toBeGreaterThan(0);
  expect(fonts.every((path) => /\/noto-sans-latin-\d+-/.test(path))).toBe(true);
  expect(precache.paths).toContain("/index.html");

  // A font used once (here: shown or drawn) is kept for offline use.
  await page.waitForFunction(() => [...document.fonts].some((face) => face.family === "Pacifico"));
  await page.evaluate(() => document.fonts.load('16px "Pacifico"', "A"));
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const cache = await caches.open("openpaint-fonts");
        return (await cache.keys()).some((request) => request.url.includes("pacifico-latin-"));
      }),
    )
    .toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "OpenPaint" })).toBeVisible();
  await expect(page.locator(".app-viewport")).toBeAttached();
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

  const status = await page.evaluate(async (path) => (await fetch(path)).status, wasm);
  expect(status).toBe(200);
  await page.waitForFunction(() => [...document.fonts].some((face) => face.family === "Pacifico"));
  const loaded = await page.evaluate(async () => {
    const faces = await document.fonts.load('16px "Pacifico"', "A");
    return faces.map((face) => face.status);
  });
  expect(loaded).toEqual(["loaded"]);
});

test("downloads every font in the background, so a font never used before draws offline", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  // A reload interrupts the first session's download; the controlled page resumes it.
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const total = bundledFontFiles().length;
  await expect
    .poll(async () => (await cachedFontFiles(page)).length, { timeout: 90_000 })
    .toBe(total);
  const cached = await cachedFontFiles(page);
  expect(cached.some((path) => /\/Lobster-Regular-[\w-]+\.otf$/.test(path))).toBe(true);
  // Nothing drew in Lobster: it was only downloaded.
  expect(await page.evaluate(() => document.fonts.check('16px "Lobster"'))).toBe(false);

  await context.setOffline(true);
  await page.reload();
  // The image of the session before may be offered back; either way one image is open.
  const restore = page.getByRole("dialog").getByRole("button", { name: "Restore", exact: true });
  await expect(page.getByRole("tab").first().or(restore)).toBeVisible();
  if (await restore.isVisible()) await restore.click();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await page.getByRole("radio", { name: "Text", exact: true }).click();
  await page.getByRole("button", { name: /Font:$/ }).click();
  await page.getByRole("option", { name: "Lobster" }).click();
  await expect(page.getByRole("button", { name: /Font:$/ })).toContainText("Lobster");
  const box = await page.locator(ENGINE_CANVAS).boundingBox();
  if (box === null) throw new Error("the engine canvas has no box");
  const textbox = page.getByRole("textbox", { name: "Text", exact: true });
  await expect(async () => {
    await page.mouse.click(box.x + box.width / 2 - 60, box.y + box.height / 2);
    await expect(textbox).toBeFocused({ timeout: 1000 });
  }).toPass();
  await page.keyboard.type("Hello");
  await expect.poll(() => page.evaluate(() => document.fonts.check('16px "Lobster"'))).toBe(true);
  const faces = await page.evaluate(async () =>
    (await document.fonts.load('16px "Lobster"', "Hello")).map((face) => face.status),
  );
  expect(faces).toEqual(["loaded"]);
  await page.keyboard.press("Escape");
  await expect(page.locator("ol.app-history-list li:last-child .app-history-name")).toHaveText(
    "Text",
  );
});
