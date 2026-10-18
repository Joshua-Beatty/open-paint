/// <reference types="node" />
import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * Dialog footers: every button shares one style (OK looks like Cancel) and the buttons never touch.
 * With UI_REVIEW_DIR set, each dialog is also saved as a screenshot in light and dark.
 */
const DIR = process.env.UI_REVIEW_DIR;
const LABEL = process.env.UI_REVIEW_LABEL ?? "shot";

/** The smallest gap between two footer buttons, in CSS px. */
const MIN_GAP = 6;

interface FooterButton {
  readonly text: string;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly style: string;
}

/** The visible buttons of the dialog's footer, left to right, with the style that tells them apart. */
async function footerButtons(dialog: Locator, footer: string): Promise<FooterButton[]> {
  return dialog.locator(footer).evaluateAll((footers) =>
    footers.flatMap((element) =>
      [...element.querySelectorAll<HTMLElement>("button")]
        .filter((button) => button.getClientRects().length > 0)
        .map((button) => {
          const box = button.getBoundingClientRect();
          const style = getComputedStyle(button);
          const look = [
            style.backgroundColor,
            style.backgroundImage,
            style.borderTopColor,
            style.borderTopWidth,
            style.borderTopStyle,
            style.borderTopLeftRadius,
            style.color,
            style.fontWeight,
            style.height,
          ];
          // Disabled, focused and hovered buttons look different on purpose.
          const plain =
            !button.hasAttribute("data-disabled") &&
            !button.hasAttribute("data-focus-visible") &&
            !button.hasAttribute("data-hovered");
          return {
            text: button.textContent ?? "",
            left: box.left,
            right: box.right,
            top: box.top,
            style: plain ? look.join(" | ") : "",
          };
        })
        .sort((a, b) => a.top - b.top || a.left - b.left),
    ),
  );
}

async function checkFooter(page: Page, name: string, footer = ".modal-actions") {
  const dialog = page.locator(".modal-dialog").last();
  await expect(dialog, name).toBeVisible();
  // Keep the pointer off the buttons, so none shows its hover style.
  await page.mouse.move(1, 1);
  const buttons = await footerButtons(dialog, footer);
  expect(buttons.length, `${name}: footer buttons`).toBeGreaterThanOrEqual(2);
  for (let index = 1; index < buttons.length; index++) {
    const before = buttons[index - 1] as FooterButton;
    const after = buttons[index] as FooterButton;
    if (Math.abs(before.top - after.top) > 2) continue;
    expect
      .soft(after.left - before.right, `${name}: gap between "${before.text}" and "${after.text}"`)
      .toBeGreaterThanOrEqual(MIN_GAP);
  }
  const styles = new Set(buttons.map((button) => button.style).filter((style) => style !== ""));
  expect.soft([...styles], `${name}: footer button styles`).toHaveLength(1);
}

async function shoot(page: Page, scheme: string, name: string) {
  if (DIR === undefined) return;
  await page.mouse.move(1, 1);
  await page
    .locator(".modal")
    .last()
    .screenshot({ path: `${DIR}/${LABEL}-${scheme}-${name}.png` });
}

async function menu(page: Page, top: string, ...items: RegExp[]) {
  await page
    .locator(".app-menu-list .app-menu-button")
    .filter({ hasText: new RegExp(`^${top}$`) })
    .click();
  for (const [index, item] of items.entries()) {
    const entry = page.getByRole("menuitem", { name: item });
    if (index < items.length - 1) await entry.hover();
    else await entry.click();
  }
}

async function cancel(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal-dialog")).toHaveCount(0);
}

test.use({ viewport: { width: 1440, height: 900 } });

for (const scheme of ["light", "dark"] as const) {
  test(`dialog footer buttons share one style and never touch (${scheme})`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    // Without the save picker, Save As asks for the name in the page, as in browsers without it.
    await page.addInitScript(() => {
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    await page.goto("/");
    await expect(page.getByRole("tab")).toHaveCount(1);
    await expect(page.getByRole("radio").first()).toBeVisible();

    const dialogs: [string, () => Promise<void>, string?][] = [
      ["new-image", () => menu(page, "File", /^New/)],
      ["resize", () => menu(page, "Image", /^Resize/)],
      ["canvas-size", () => menu(page, "Image", /^Canvas Size/)],
      ["layer-properties", () => menu(page, "Layers", /^Layer Properties/)],
      ["gaussian-blur", () => menu(page, "Effects", /^Blurs/, /^Gaussian Blur/)],
      ["brightness-contrast", () => menu(page, "Adjustments", /^Brightness/)],
      ["levels", () => menu(page, "Adjustments", /^Levels/), ".levels-footer"],
      ["curves", () => menu(page, "Adjustments", /^Curves/), ".curves-footer"],
      ["print", () => menu(page, "File", /^Print/)],
    ];
    for (const [name, open, footer] of dialogs) {
      await open();
      await checkFooter(page, name, footer);
      await shoot(page, scheme, name);
      await cancel(page);
    }

    // Save in the page (without the picker there is no Save As), then the JPEG options.
    await menu(page, "File", /^Save(?! As| All)/);
    await checkFooter(page, "save-as");
    await shoot(page, scheme, "save-as");
    const saveAs = page.locator(".modal-dialog").last();
    const type = saveAs.locator("select");
    const jpeg = await type
      .locator("option")
      .evaluateAll(
        (options) =>
          (options as HTMLOptionElement[]).find((option) => /jpe?g/i.test(option.textContent ?? ""))
            ?.value,
      );
    if (jpeg === undefined) throw new Error("no JPEG save type");
    await type.selectOption(jpeg);
    await saveAs.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".save-config")).toBeVisible();
    await checkFooter(page, "save-options");
    await shoot(page, scheme, "save-options");
    await cancel(page);

    // The palette name dialog, from the Colors panel.
    const palettes = page.getByRole("button", { name: "Palettes", exact: true });
    if (!(await palettes.isVisible())) {
      await page.getByRole("button", { name: "More", exact: true }).click();
    }
    await palettes.click();
    await page.getByRole("menuitem", { name: /^Save Current Palette As/ }).click();
    await checkFooter(page, "palette-save");
    await shoot(page, scheme, "palette-save");
    await cancel(page);

    // Unsaved Changes, from closing an edited image.
    await page.locator(".app-canvas-area").click({ position: { x: 4, y: 4 } });
    // A selection alone on the blank image is not unsaved work, so the selection is erased.
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Delete");
    await expect(page.locator(".app-image-tab-dirty")).toHaveCount(1);
    await menu(page, "File", /^Close(?! All)/);
    await checkFooter(page, "unsaved-changes");
    await shoot(page, scheme, "unsaved-changes");
    await cancel(page);
  });
}
