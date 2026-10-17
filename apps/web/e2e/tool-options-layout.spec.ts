import { expect, type Page, test } from "@playwright/test";

/** The tool options row (UI-TB-03) and the More button of its overflow menu. */
const STRIP = ".app-tool-config";
const MORE = { name: "More options" } as const;

interface StripLayout {
  readonly height: number;
  readonly canvasTop: number;
  readonly overflowed: number;
  /** Items whose box is not on the row's one line, or is taller than the row. */
  readonly offRow: readonly string[];
}

async function stripLayout(page: Page): Promise<StripLayout> {
  return page.evaluate((selector) => {
    const strip = document.querySelector<HTMLElement>(selector);
    const canvas = document.querySelector<HTMLElement>(".app-canvas-area");
    if (strip === null || canvas === null) throw new Error("no strip or canvas area");
    const row = strip.getBoundingClientRect();
    const items = [...strip.querySelectorAll<HTMLElement>("[data-strip-item]")].filter(
      (item) => !item.hasAttribute("data-overflowed"),
    );
    const offRow = items
      .filter((item) => {
        const box = item.getBoundingClientRect();
        return box.top < row.top - 0.5 || box.bottom > row.bottom + 0.5 || box.height > row.height;
      })
      .map((item) => item.textContent ?? item.getAttribute("aria-label") ?? "?");
    return {
      height: row.height,
      canvasTop: canvas.getBoundingClientRect().top,
      overflowed: strip.querySelectorAll("[data-overflowed]").length,
      offRow,
    };
  }, STRIP);
}

/** Every tool in the Tools panel, in roster order. */
async function toolNames(page: Page): Promise<string[]> {
  const radios = page.locator(".app-sidebar-left").getByRole("radio");
  await expect(radios.first()).toBeVisible();
  return radios.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("aria-label") ?? element.textContent ?? ""),
  );
}

async function selectTool(page: Page, name: string) {
  const radio = page.locator(".app-sidebar-left").getByRole("radio", { name, exact: true });
  await radio.click();
  await expect(radio).toBeChecked();
}

for (const size of [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
] as const) {
  test(`every tool's options fit one row of constant height at ${size.width}x${size.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await page.goto("/");
    await expect(page.getByRole("tab")).toHaveCount(1);
    const first = await stripLayout(page);
    expect(first.height).toBeGreaterThan(0);

    const check = async (scope: string) => {
      const layout = await stripLayout(page);
      expect(layout.height, scope).toBe(first.height);
      expect(layout.canvasTop, scope).toBe(first.canvasTop);
      expect(layout.overflowed, `${scope}: items in the More menu`).toBe(0);
      expect(layout.offRow, `${scope}: items off the row`).toEqual([]);
      await expect(page.locator(STRIP).getByRole("button", MORE), scope).toHaveCount(0);
    };

    for (const name of await toolNames(page)) {
      await selectTool(page, name);
      await check(name);
    }

    // The widest modes: Rectangle Select's fixed size boxes and the rounded rectangle's corner.
    await selectTool(page, "Rectangle Select");
    await page
      .locator(STRIP)
      .getByRole("button", { name: /Draw mode/ })
      .click();
    await page.getByRole("option", { name: "Fixed Size" }).click();
    await check("Rectangle Select, Fixed Size");
    await page
      .locator(STRIP)
      .getByRole("button", { name: /Draw mode/ })
      .click();
    await page.getByRole("option", { name: "Any Size" }).click();

    await selectTool(page, "Shapes");
    await page
      .locator(STRIP)
      .getByRole("button", { name: /Shape type/ })
      .click();
    await page.getByRole("option", { name: "Rounded Rectangle" }).click();
    await check("Shapes, Rounded Rectangle");
  });
}

test("a narrow window moves the options that do not fit into the More menu", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  await selectTool(page, "Paintbrush");

  const strip = page.locator(STRIP);
  const more = strip.getByRole("button", MORE);
  await expect(more).toBeVisible();
  // Selection quality is an option only while there is a selection; Select All brings it in (here,
  // straight into the More menu, so the row's item is counted whether or not it is shown).
  const qualityItem = strip.locator("[data-strip-item]", { hasText: "Selection:" });
  await expect(qualityItem).toHaveCount(0);
  await page.keyboard.press("Control+A");
  await expect(qualityItem).toHaveCount(1);
  const layout = await stripLayout(page);
  expect(layout.overflowed).toBeGreaterThan(0);
  expect(layout.offRow).toEqual([]);

  const hidden = await strip
    .locator("[data-overflowed]")
    .evaluateAll((items) => items.map((item) => item.textContent));
  await more.click();
  const menu = page.getByRole("dialog", MORE);
  await expect(menu).toBeVisible();
  const listed = await menu
    .locator("[data-strip-item]:not([hidden])")
    .evaluateAll((items) => items.map((item) => item.textContent));
  expect(listed).toEqual(hidden);

  // A control in the menu works like its row twin: Selection quality is the last option.
  const quality = menu.getByRole("button", { name: /Selection rendering quality/ });
  await expect(quality).toBeVisible();
  await quality.click();
  await page.getByRole("option", { name: "Pixelated selection quality" }).click();
  // The button's shown value; the other values sit hidden beside it to size the button.
  await expect(
    menu
      .getByRole("button", { name: /Selection rendering quality/ })
      .locator(".prop-select-current"),
  ).toHaveText("Selection: Pixelated");

  // Widening the window brings the items back into the row.
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect(more).toHaveCount(0);
  await expect(strip.locator("[data-overflowed]")).toHaveCount(0);
});

test("the Pressure option appears once a pen touches the canvas, and stays after a reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  await selectTool(page, "Paintbrush");
  const strip = page.locator(STRIP);
  const pressure = strip.getByRole("button", { name: /Pressure/ });
  await expect(strip.getByRole("slider", { name: "Hardness" })).toBeVisible();
  await expect(pressure).toHaveCount(0);

  const canvas = page.locator("[data-backend] canvas:not(.app-canvas-overlay)");
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("the engine canvas has no box");
  await canvas.dispatchEvent("pointermove", {
    pointerType: "pen",
    pointerId: 2,
    isPrimary: true,
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
    bubbles: true,
  });
  await expect(pressure).toBeVisible();
  await expect(pressure.locator(".prop-select-current")).toHaveText("Pressure: On");
  // The row keeps one line with the extra option.
  const layout = await stripLayout(page);
  expect(layout.overflowed).toBe(0);
  expect(layout.offRow).toEqual([]);

  // A later session shows it before the pen touches the canvas.
  // Settings writes are batched for 500 ms before they reach storage (SET-STO-01).
  await page.waitForTimeout(1500);
  await page.reload();
  // Only the first run opens a new image, so the reloaded page has no tab.
  await expect(strip.getByRole("slider", { name: "Hardness" })).toBeVisible();
  await expect(strip.getByRole("button", { name: /Pressure/ })).toBeVisible();
});

test("the shape picker shows every shape's outline beside its name, and the chosen one on its button", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  await selectTool(page, "Shapes");
  const picker = page.locator(STRIP).getByRole("button", { name: /Shape type/ });
  await picker.click();
  const options = page.getByRole("listbox").getByRole("option");
  expect(await options.count()).toBeGreaterThan(10);
  const icons = await options.evaluateAll((items) =>
    items.map((item) => item.querySelector("svg.prop-icon path")?.getAttribute("d") ?? ""),
  );
  expect(icons.every((icon) => icon.startsWith("M"))).toBe(true);
  expect(new Set(icons).size).toBe(icons.length);
  const ellipse = page.getByRole("option", { name: "Ellipse", exact: true });
  const ellipseIcon = await ellipse.locator("svg.prop-icon path").getAttribute("d");
  await ellipse.click();
  await expect(picker).toContainText("Ellipse");
  await expect(picker.locator("svg.prop-icon path")).toHaveAttribute("d", ellipseIcon ?? "");
});

test("dragging an inline slider back and forth selects no text", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  await selectTool(page, "Paintbrush");
  const slider = page.locator(STRIP).getByRole("slider", { name: "Hardness" });
  const box = await slider.boundingBox();
  if (box === null) throw new Error("the Hardness slider has no box");
  const y = box.y + box.height / 2;
  const selected = () => page.evaluate(() => window.getSelection()?.toString() ?? "");
  // Quick drags one after another: the second press comes within the double-click time.
  for (let drag = 0; drag < 3; drag++) {
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down({ clickCount: drag + 1 });
    for (const x of [box.x + box.width - 2, box.x + 2, box.x + box.width + 40, box.x - 40]) {
      await page.mouse.move(x, y, { steps: 3 });
    }
    expect(await selected()).toBe("");
    await page.mouse.up({ clickCount: drag + 1 });
    expect(await selected()).toBe("");
  }
  // The drag set the value, so the slider still works and kept focus for the keyboard.
  await expect(slider).toHaveAttribute("aria-valuenow", "0");
});
