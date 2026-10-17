import { expect, type Page, test } from "@playwright/test";

/** The history panel's step names, oldest first (UI-FTW-04). */
const LAST_STEP = "ol.app-history-list li:last-child .app-history-name";

/** The engine canvas, without the overlays that sit on top of it. */
const ENGINE_CANVAS = "[data-backend] canvas:not(.app-canvas-overlay)";

test.use({ viewport: { width: 1440, height: 900 } });

/** Which pixels of the engine canvas are dark, from a screenshot, as one 0/1 string. */
async function darkPixels(page: Page): Promise<string> {
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
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let flags = "";
    for (let i = 0; i < data.length; i += 4) {
      flags += (data[i] ?? 255) + (data[i + 1] ?? 255) + (data[i + 2] ?? 255) < 384 ? "1" : "0";
    }
    return flags;
  }, png.toString("base64"));
}

function differing(a: string, b: string): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) total++;
  return total;
}

/** Types a word at the centre of the canvas and commits it with Esc (TL-TEXT-01). */
async function typeText(page: Page, text: string) {
  const box = await page.locator(ENGINE_CANVAS).boundingBox();
  if (box === null) throw new Error("the engine canvas has no box");
  await page.mouse.click(box.x + box.width / 2 - 60, box.y + box.height / 2);
  await expect(page.getByRole("textbox", { name: "Text", exact: true })).toBeFocused();
  await page.keyboard.type(text);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  await page.getByRole("radio", { name: "Text", exact: true }).click();
});

test("the font list is one list sorted by name, each name in its own face (WEB-FONT-01)", async ({
  page,
}) => {
  // The bundled faces are registered at start-up, but not fetched until they are shown.
  await page.waitForFunction(() => [...document.fonts].some((face) => face.family === "Pacifico"));
  expect(await page.evaluate(() => document.fonts.check('16px "Pacifico"'))).toBe(false);
  await page.getByRole("button", { name: /Font:$/ }).click();
  const list = page.getByRole("listbox");
  await expect(list.getByRole("option", { name: "Pacifico" })).toBeVisible();
  await expect(list.getByRole("group")).toHaveCount(0);
  const names = await list.getByRole("option").allTextContents();
  expect(names).toHaveLength(34);
  // The fonts whose license reserves their name ship as their complete upstream files.
  for (const family of ["Lobster", "Lora", "Merriweather", "Playfair Display"]) {
    expect(names).toContain(family);
  }
  expect(names).toEqual(
    [...names].sort(new Intl.Collator("en", { sensitivity: "base", numeric: true }).compare),
  );
  expect(names.slice(0, 3)).toEqual(["Anton", "Archivo Black", "Bangers"]);
  const name = list.getByRole("option", { name: "Pacifico" }).locator("span");
  expect(await name.evaluate((node) => getComputedStyle(node).fontFamily)).toContain("Pacifico");
  await expect.poll(() => page.evaluate(() => document.fonts.check('16px "Pacifico"'))).toBe(true);
});

test("text committed in a newly chosen font is drawn in that font (WEB-FONT-01, TL-TEXT-01)", async ({
  page,
}) => {
  const blank = await darkPixels(page);
  await typeText(page, "Hello");
  await expect.poll(() => page.evaluate(() => document.fonts.check('16px "Noto Sans"'))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator(LAST_STEP)).toHaveText("Text");
  const defaultFont = await darkPixels(page);
  expect(differing(blank, defaultFont)).toBeGreaterThan(20);

  await page.keyboard.press("Control+z");
  await expect.poll(async () => differing(blank, await darkPixels(page))).toBe(0);

  await page.getByRole("button", { name: /Font:$/ }).click();
  await page.getByRole("option", { name: "Pacifico" }).click();
  await expect(page.getByRole("button", { name: /Font:$/ })).toContainText("Pacifico");
  await typeText(page, "Hello");
  await expect.poll(() => page.evaluate(() => document.fonts.check('16px "Pacifico"'))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator(LAST_STEP)).toHaveText("Text");
  const chosenFont = await darkPixels(page);
  expect(differing(blank, chosenFont)).toBeGreaterThan(20);
  expect(differing(defaultFont, chosenFont)).toBeGreaterThan(40);
});
