import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";

/** WCAG 2.2 AA is the bar for the UI chrome (WEB-A11Y-01). The canvas is exempt. */
const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Items with an ellipsis that open a native file or print picker, not an in-page dialog. */
const NATIVE_PICKER = /^(Open\.\.\.|Save As\.\.\.|Print\.\.\.|Import From File\.\.\.)/;

interface MenuEntry {
  readonly label: string;
  readonly enabled: boolean;
  readonly group: boolean;
}

async function settleAnimations(page: Page): Promise<void> {
  // Axe samples colors, so a fade still running would measure a half-transparent element.
  // Infinite animations (spinners) never finish and are skipped.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

/**
 * The palette is 16 swatches wide at the owner's request, so in a sidebar its swatches are 12 to
 * 16 px, under the 24 px target size. They fall under the target-size "equivalent" exception
 * (WCAG 2.5.8): the same colors can be set with the panel's expanded editor (hex box, sliders).
 */
function isExemptTarget(rule: string, html: string): boolean {
  return rule === "target-size" && html.includes('class="color-palette-swatch"');
}

/** Every WCAG 2.2 AA violation on the page, each tagged with the scope it was found in. */
async function violationsOf(page: Page, scope: string): Promise<string[]> {
  await settleAnimations(page);
  const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  for (const violation of results.violations) {
    violation.nodes = violation.nodes.filter((node) => !isExemptTarget(violation.id, node.html));
  }
  results.violations = results.violations.filter((violation) => violation.nodes.length > 0);
  return results.violations.map(
    (violation) =>
      `[${scope}] ${violation.id} (${violation.impact}): ${violation.nodes
        .map((node) => `${node.target.join(" ")} ${node.html.slice(0, 160)}`)
        .join(" | ")}`,
  );
}

function menuBarButtons(page: Page): Locator {
  return page.locator(".app-menu-list .app-menu-button");
}

/** The newest open menu: the main menu, or the submenu opened last. */
function newestMenu(page: Page): Locator {
  return page.getByRole("menu").last();
}

async function closeAllMenus(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 5 && (await page.getByRole("menu").count()) > 0; attempt++) {
    await page.keyboard.press("Escape");
  }
  await expect(page.getByRole("menu")).toHaveCount(0);
}

/**
 * Opens a menu chain: a main menu index, then submenu group indexes. Each step opens one more
 * menu, so a chain of length n leaves n menus open.
 */
async function openChain(page: Page, chain: readonly number[]): Promise<void> {
  await closeAllMenus(page);
  for (const [depth, index] of chain.entries()) {
    if (depth === 0) {
      await menuBarButtons(page).nth(index).click();
    } else {
      await newestMenu(page).getByRole("menuitem").nth(index).click();
    }
    await expect(page.getByRole("menu")).toHaveCount(depth + 1);
  }
}

async function entriesOf(menu: Locator): Promise<MenuEntry[]> {
  return menu.getByRole("menuitem").evaluateAll((items) =>
    items.map((item) => ({
      label: item.textContent ?? "",
      enabled: item.getAttribute("aria-disabled") !== "true",
      group: item.classList.contains("app-menu-group"),
    })),
  );
}

function isDialogItem(entry: MenuEntry): boolean {
  return (
    entry.enabled && !entry.group && entry.label.includes("...") && !NATIVE_PICKER.test(entry.label)
  );
}

test("the app shell has no WCAG 2.2 AA violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  expect(await violationsOf(page, "shell")).toEqual([]);
});

test("every main menu and submenu passes axe with it open", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  const findings: string[] = [];
  const count = await menuBarButtons(page).count();
  for (let index = 0; index < count; index++) {
    await openChain(page, [index]);
    findings.push(...(await violationsOf(page, `menu ${index}`)));
    const entries = await entriesOf(newestMenu(page));
    for (const [position, entry] of entries.entries()) {
      if (!entry.group || !entry.enabled) continue;
      await openChain(page, [index, position]);
      findings.push(...(await violationsOf(page, `${index}>${entry.label}`)));
    }
  }
  await closeAllMenus(page);
  expect(findings).toEqual([]);
});

/** Scans the open dialog, then closes it with Escape. */
async function scanOpenDialog(page: Page, scope: string): Promise<string[]> {
  const dialog = page.locator(".modal-dialog");
  await expect(dialog, scope).toBeVisible();
  const found = await violationsOf(page, scope);
  await page.keyboard.press("Escape");
  await expect(dialog, scope).toHaveCount(0);
  return found;
}

test("panels, aux controls, the tab menus and their dialogs pass axe", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  const findings: string[] = [];

  const panelToggles = page.getByRole("group", { name: "Panels" }).getByRole("button");
  const panelCount = await panelToggles.count();
  for (let index = 0; index < panelCount; index++) {
    await panelToggles.nth(index).click();
    findings.push(...(await violationsOf(page, `panel ${index} hidden`)));
    await panelToggles.nth(index).click();
  }
  findings.push(...(await violationsOf(page, "all panels shown")));

  await page.getByRole("button", { name: "Settings" }).click();
  findings.push(...(await scanOpenDialog(page, "Settings")));

  const help = page.getByRole("button", { name: "Help" });
  await help.click();
  const helpEntries = await entriesOf(newestMenu(page));
  findings.push(...(await violationsOf(page, "Help menu")));
  await closeAllMenus(page);
  for (const [position, entry] of helpEntries.entries()) {
    if (!isDialogItem(entry)) continue;
    await help.click();
    await newestMenu(page).getByRole("menuitem").nth(position).click();
    findings.push(...(await scanOpenDialog(page, `Help>${entry.label}`)));
  }

  await page.getByRole("button", { name: "Image list" }).click();
  findings.push(...(await violationsOf(page, "image list menu")));
  await closeAllMenus(page);

  await page.getByRole("tab", { name: "Untitled" }).click({ button: "right" });
  findings.push(...(await violationsOf(page, "tab context menu")));
  await closeAllMenus(page);

  await page.getByRole("button", { name: "Layer Properties" }).click();
  findings.push(...(await scanOpenDialog(page, "Layer Properties")));

  await page.getByRole("button", { name: "Palettes" }).click();
  const palette = await entriesOf(newestMenu(page));
  findings.push(...(await violationsOf(page, "palette menu")));
  await closeAllMenus(page);
  for (const [position, entry] of palette.entries()) {
    // Import and Export open native pickers, and Reset applies at once.
    if (!entry.enabled || /^(Import|Export|Reset)/.test(entry.label)) continue;
    await page.getByRole("button", { name: "Palettes" }).click();
    await newestMenu(page).getByRole("menuitem").nth(position).click();
    findings.push(...(await scanOpenDialog(page, `Palettes>${entry.label}`)));
  }

  expect(findings).toEqual([]);
});

test("the Unsaved Changes dialog, reached from the keyboard, passes axe", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  const dialog = page.locator(".modal-dialog");
  await page.keyboard.press("Control+N");
  await expect(dialog).toBeVisible();
  await page.getByRole("button", { name: "OK" }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(2);

  // Erasing the selection changes pixels, so the new image has unsaved work and Ctrl+W asks first
  // (a selection alone on a blank image does not count).
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await expect(page).toHaveTitle(/^\*/);
  await page.keyboard.press("Control+W");
  await expect(dialog).toBeVisible();
  const findings = await violationsOf(page, "Unsaved Changes");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(2);
  expect(findings).toEqual([]);
});

test("the Levels color picker opens from the keyboard and passes axe", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  const count = await menuBarButtons(page).count();
  let opened = false;
  for (let index = 0; index < count && !opened; index++) {
    await openChain(page, [index]);
    const entries = await entriesOf(newestMenu(page));
    const position = entries.findIndex((entry) => entry.enabled && /^Levels/.test(entry.label));
    if (position >= 0) {
      await newestMenu(page).getByRole("menuitem").nth(position).click();
      opened = true;
    }
  }
  expect(opened, "Levels is in a menu").toBe(true);
  const dialog = page.locator(".modal-dialog");
  await expect(dialog).toHaveCount(1);

  await page.locator(".levels-swatch").first().focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(2);
  const findings = await violationsOf(page, "Levels with its color picker");

  await dialog.last().getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(1);
  await page.getByRole("button", { name: "Cancel" }).last().click();
  await expect(dialog).toHaveCount(0);
  expect(findings).toEqual([]);
});

test("every dialog opened from a menu passes axe", async ({ page }) => {
  test.setTimeout(900_000);
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  const count = await menuBarButtons(page).count();
  const findings: string[] = [];

  // Native pickers (open, import, save) are not in-page dialogs. Their chooser is counted here.
  let choosers = 0;
  page.on("filechooser", () => {
    choosers++;
  });

  const scanDialog = async (chain: readonly number[], position: number, label: string) => {
    await openChain(page, chain);
    const before = choosers;
    await newestMenu(page).getByRole("menuitem").nth(position).click();
    const dialog = page.locator(".modal-dialog");
    await expect
      .poll(async () => (await dialog.count()) > 0 || choosers > before, { message: label })
      .toBe(true);
    if ((await dialog.count()) === 0) {
      await closeAllMenus(page);
      return;
    }
    await expect(dialog, label).toBeVisible();
    findings.push(...(await violationsOf(page, label)));
    await page.keyboard.press("Escape");
    await expect(dialog, label).toHaveCount(0);
  };

  for (let index = 0; index < count; index++) {
    await openChain(page, [index]);
    const entries = await entriesOf(newestMenu(page));
    for (const [position, entry] of entries.entries()) {
      if (entry.group && entry.enabled) {
        await openChain(page, [index, position]);
        const submenu = await entriesOf(newestMenu(page));
        for (const [subPosition, sub] of submenu.entries()) {
          if (isDialogItem(sub)) {
            await scanDialog([index, position], subPosition, `${entry.label}>${sub.label}`);
          }
        }
      } else if (isDialogItem(entry)) {
        await scanDialog([index], position, entry.label);
      }
    }
  }
  expect(findings).toEqual([]);
});

test("the open-source licenses page and the font list pass axe", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  const findings: string[] = [];

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("option", { name: "Open-Source Licenses" }).click();
  const font = page.getByRole("button", { name: /^Pacifico \d/ });
  await font.click();
  await expect(font).toHaveAttribute("aria-expanded", "true");
  findings.push(...(await scanOpenDialog(page, "Settings>Open-Source Licenses")));

  await page.getByRole("radio", { name: "Text", exact: true }).click();
  await page.getByRole("button", { name: /Font:$/ }).click();
  await expect(page.getByRole("listbox").getByRole("option", { name: "Pacifico" })).toBeVisible();
  findings.push(...(await violationsOf(page, "Text tool font list")));
  await page.keyboard.press("Escape");
  expect(findings).toEqual([]);
});
