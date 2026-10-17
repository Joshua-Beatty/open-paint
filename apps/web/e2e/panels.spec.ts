import { expect, type Page, test } from "@playwright/test";

/** The boxes of the palette's swatches, in palette order. */
async function swatchBoxes(page: Page) {
  const swatches = page.locator(".color-palette-swatch");
  await expect(swatches).toHaveCount(96);
  return swatches.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right };
    }),
  );
}

test.describe("Colors panel", () => {
  for (const viewport of [
    { width: 1440, height: 900 },
    // Below 1280 CSS px the right sidebar takes its minimum width (UI-FTW-08).
    { width: 1200, height: 800 },
  ]) {
    test(`the palette is 16 swatches wide and fits the sidebar at ${viewport.width} px`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto("/");
      const boxes = await swatchBoxes(page);
      const rows = new Set(boxes.map((box) => Math.round(box.y)));
      expect(rows.size).toBe(6);
      const first = boxes[0];
      const sixteenth = boxes[15];
      const seventeenth = boxes[16];
      if (first === undefined || sixteenth === undefined || seventeenth === undefined) {
        throw new Error("missing swatches");
      }
      expect(Math.round(sixteenth.y)).toBe(Math.round(first.y));
      expect(seventeenth.x).toBeCloseTo(first.x, 0);
      expect(seventeenth.y).toBeGreaterThan(first.y);
      expect(first.width).toBeGreaterThanOrEqual(12);
      expect(first.height).toBeCloseTo(first.width, 0);

      const panel = await page.locator(".colors-panel").boundingBox();
      if (panel === null) throw new Error("no colors panel");
      expect(sixteenth.right).toBeLessThanOrEqual(panel.x + panel.width);
      // The compact panel's content fits its body without scrolling (UI-FTW-01).
      const fits = await page.locator(".colors-panel").evaluate((element) => {
        const body = element.parentElement;
        return body === null || body.scrollHeight <= body.clientHeight + 1;
      });
      expect(fits).toBe(true);
    });

    test(`the expanded editor's fields are one size and fit the sidebar at ${viewport.width} px`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto("/");
      await page.getByRole("button", { name: "More >>" }).click();
      const panel = await page.locator(".colors-panel").boundingBox();
      if (panel === null) throw new Error("no colors panel");
      const fields = await page
        .locator(".color-spin input, .color-hex input, .color-slider-row")
        .evaluateAll((elements) =>
          elements.map((element) => {
            const box = element.getBoundingClientRect();
            return { input: element.tagName === "INPUT", height: box.height, right: box.right };
          }),
        );
      // Seven spin boxes and the hex box, and seven slider rows.
      expect(fields.filter((field) => field.input)).toHaveLength(8);
      expect(fields.filter((field) => !field.input)).toHaveLength(7);
      expect(new Set(fields.map((field) => Math.round(field.height))).size).toBe(1);
      for (const field of fields) expect(field.right).toBeLessThanOrEqual(panel.x + panel.width);
    });
  }
});

/** The outer heights of the right sidebar's panels, top to bottom. */
async function panelHeights(page: Page) {
  return page
    .locator(".app-right-sidebar > .app-panel")
    .evaluateAll((panels) => panels.map((panel) => panel.getBoundingClientRect().height));
}

test.describe("Expanded Colors panel", () => {
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
  ]) {
    test(`More fits without scrolling and Less restores the panels at ${viewport.width} x ${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto("/");
      await expect(page.getByRole("tab")).toHaveCount(1);
      const before = await panelHeights(page);
      await page.getByRole("button", { name: "More >>" }).click();
      await expect(page.getByRole("button", { name: "<< Less" })).toBeVisible();
      // The wheel sits beside the sliders, not above them.
      const wheel = await page.getByRole("img", { name: "Color wheel" }).boundingBox();
      const red = await page.locator(".color-slider-track").first().boundingBox();
      if (wheel === null || red === null) throw new Error("no editor");
      expect(red.x).toBeGreaterThan(wheel.x + wheel.width);
      expect(red.y).toBeLessThan(wheel.y + wheel.height);
      const body = await page.locator(".colors-panel").evaluate((element) => {
        const parent = element.parentElement as HTMLElement;
        return { scroll: parent.scrollHeight, client: parent.clientHeight };
      });
      expect(body.scroll).toBeLessThanOrEqual(body.client);
      await page.getByRole("button", { name: "<< Less" }).click();
      await expect(page.getByRole("button", { name: "More >>" })).toBeVisible();
      expect(await panelHeights(page)).toEqual(before);
    });
  }

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1366, height: 768 },
    { width: 1280, height: 720 },
  ]) {
    test(`the Layers and History toolbars stay in view with More open at ${viewport.width} x ${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto("/");
      await expect(page.getByRole("tab")).toHaveCount(1);
      await page.getByRole("button", { name: "More >>" }).click();
      await expect(page.getByRole("button", { name: "<< Less" })).toBeVisible();
      for (const toolbar of [".app-layer-toolbar", ".app-history-toolbar"]) {
        const box = await page.locator(toolbar).evaluate((element) => {
          const own = element.getBoundingClientRect();
          const panel = (element.closest(".app-panel") as HTMLElement).getBoundingClientRect();
          return {
            top: own.top,
            bottom: own.bottom,
            panelTop: panel.top,
            panelBottom: panel.bottom,
          };
        });
        expect(box.top, toolbar).toBeGreaterThanOrEqual(box.panelTop);
        expect(box.bottom, toolbar).toBeLessThanOrEqual(box.panelBottom);
        expect(box.bottom, toolbar).toBeLessThanOrEqual(viewport.height);
      }
      for (const name of ["Undo", "Redo", "Layer Properties"]) {
        await expect(page.getByRole("button", { name, exact: true }).last()).toBeInViewport({
          ratio: 1,
        });
      }
    });
  }
});

test("the Layers and History toolbars are icon buttons whose tooltips name them and close on leave", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  const layers = page.getByRole("toolbar", { name: "Layer tools" });
  const history = page.getByRole("toolbar", { name: "History tools" });
  await expect(layers.getByRole("button")).toHaveCount(7);
  await expect(history.getByRole("button")).toHaveCount(2);
  for (const button of await layers.getByRole("button").all()) {
    await expect(button.locator("svg")).toHaveCount(1);
    await expect(button).toHaveText("");
    const box = await button.boundingBox();
    expect(box?.width).toBe(28);
    expect(box?.height).toBe(24);
  }

  const add = layers.getByRole("button", { name: "Add New Layer" });
  // The first pointer move sets the pointer modality that hover tooltips wait for.
  await page.mouse.move(700, 400);
  await add.hover();
  const tip = page.getByRole("tooltip");
  await expect(tip).toHaveText(/^Add New Layer\s*Shortcut key: Ctrl\+Shift\+N/);
  await page.mouse.move(700, 400);
  await expect(tip).toHaveCount(0);

  await add.click();
  await page.mouse.move(700, 400);
  await expect(page.locator(".app-layer-row")).toHaveCount(2);
  await history.getByRole("button", { name: "Undo" }).hover();
  await expect(tip).toHaveText(/^Undo \(Step Backward\)\s*Shortcut key: Ctrl\+Z$/);
  await page.mouse.move(700, 400);
  await expect(tip).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`a hovered or focused swatch is ringed without moving, ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const before = await swatchBoxes(page);
    const rings = (index: number) =>
      page
        .locator(".color-palette-swatch")
        .nth(index)
        .evaluate((element) => {
          const style = getComputedStyle(element);
          return { shadow: style.boxShadow, border: style.borderTopColor };
        });
    const idle = await rings(16);
    expect(idle.shadow).toBe("none");
    // White, black and a mid colour all get the same black and white rings.
    for (const index of [16, 0, 2]) {
      await page.locator(".color-palette-swatch").nth(index).hover();
      const hovered = await rings(index);
      expect(hovered.border).toBe("rgb(255, 255, 255)");
      expect(hovered.shadow).toContain("rgb(0, 0, 0) 0px 0px 0px 1px inset");
      expect(hovered.shadow).toMatch(/rgb\(0, 0, 0\) 0px 0px 0px 1px(,|$)/);
    }
    expect(await swatchBoxes(page)).toEqual(before);

    await page.mouse.move(0, 0);
    await page.locator(".color-palette-swatch").nth(5).focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    const focused = await rings(5);
    expect(focused.border).toBe("rgb(255, 255, 255)");
    expect(focused.shadow).toContain("0px 0px 0px 3px");
    expect(await swatchBoxes(page)).toEqual(before);
  });
}
