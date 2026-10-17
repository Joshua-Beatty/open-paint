import { expect, type Page, test } from "@playwright/test";

interface MenuEntry {
  readonly label: string;
  readonly enabled: boolean;
  readonly group: boolean;
}

/** What is wrong with the layout of the open dialog, or nothing. */
async function overflowOf(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const modals = [...document.querySelectorAll<HTMLElement>(".modal")];
    for (const modal of modals) {
      const box = modal.getBoundingClientRect();
      if (modal.scrollWidth > modal.clientWidth) {
        // Name the widest content, so a failure points at the control that does not fit.
        const right = box.right;
        const widest = [...modal.querySelectorAll<HTMLElement>("*")]
          .filter((element) => element.getBoundingClientRect().right > right + 0.5)
          .map((element) => {
            const name = element.className || element.tagName;
            return `${String(name)} (${Math.round(element.getBoundingClientRect().right - right)} px)`;
          })
          .slice(0, 3);
        problems.push(
          `scrolls sideways: ${modal.scrollWidth} > ${modal.clientWidth}; ${widest.join(", ")}`,
        );
      }
      if (
        box.left < 0 ||
        box.top < 0 ||
        box.right > window.innerWidth ||
        box.bottom > window.innerHeight
      ) {
        problems.push(
          `outside the ${window.innerWidth}x${window.innerHeight} viewport: ${Math.round(box.left)},${Math.round(box.top)} to ${Math.round(box.right)},${Math.round(box.bottom)}`,
        );
      }
    }
    return problems;
  });
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
]) {
  test.describe(`at ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test("every effect and adjustment dialog fits, on every tab, with no sideways scrolling", async ({
      page,
    }) => {
      test.setTimeout(600_000);
      await page.goto("/");
      await expect(page.getByRole("tab")).toHaveCount(1);
      await expect(page.getByRole("radio").first()).toBeVisible();
      await expect(page.locator(".app-status-zoom")).toHaveText(/\d+%/);
      const menuBar = page.locator(".app-menu-list .app-menu-button");
      const newest = () => page.getByRole("menu").last();
      const closeMenus = async () => {
        for (
          let attempt = 0;
          attempt < 5 && (await page.getByRole("menu").count()) > 0;
          attempt++
        ) {
          await page.keyboard.press("Escape");
        }
        await expect(page.getByRole("menu")).toHaveCount(0);
      };
      const entries = async (): Promise<MenuEntry[]> =>
        newest()
          .getByRole("menuitem")
          .evaluateAll((items) =>
            items.map((item) => ({
              label: item.textContent ?? "",
              enabled: item.getAttribute("aria-disabled") !== "true",
              group: item.classList.contains("app-menu-group"),
            })),
          );
      const open = async (chain: readonly number[]) => {
        await closeMenus();
        for (const [depth, index] of chain.entries()) {
          if (depth === 0) await menuBar.nth(index).click();
          else await newest().getByRole("menuitem").nth(index).click();
          await expect(page.getByRole("menu")).toHaveCount(depth + 1);
        }
      };

      const problems: string[] = [];
      let dialogs = 0;
      const check = async (chain: readonly number[], position: number, label: string) => {
        await open(chain);
        await newest().getByRole("menuitem").nth(position).click();
        const dialog = page.locator(".modal-dialog");
        await expect(dialog, label).toHaveCount(1, { timeout: 15_000 });
        dialogs++;
        const tabs = dialog.getByRole("tab");
        const tabCount = await tabs.count();
        for (let tab = 0; tab < Math.max(tabCount, 1); tab++) {
          let where = label;
          if (tabCount > 0) {
            await tabs.nth(tab).click();
            await expect(tabs.nth(tab)).toHaveAttribute("aria-selected", "true");
            where = `${label} [${(await tabs.nth(tab).textContent()) ?? tab}]`;
          }
          for (const problem of await overflowOf(page)) problems.push(`${where}: ${problem}`);
        }
        await page.keyboard.press("Escape");
        await expect(dialog, label).toHaveCount(0);
      };

      for (const name of ["Adjustments", "Effects"]) {
        const index = (await menuBar.allTextContents()).indexOf(name);
        expect(index, name).toBeGreaterThanOrEqual(0);
        await open([index]);
        for (const [position, entry] of (await entries()).entries()) {
          if (entry.group && entry.enabled) {
            await open([index, position]);
            for (const [sub, item] of (await entries()).entries()) {
              if (item.enabled && !item.group && item.label.includes("...")) {
                await check([index, position], sub, `${entry.label}>${item.label}`);
              }
            }
          } else if (entry.enabled && !entry.group && entry.label.includes("...")) {
            await check([index], position, entry.label);
          }
        }
      }
      expect(problems).toEqual([]);
      // Every configurable adjustment and effect: 9 adjustments and 41 effects today.
      expect(dialogs).toBeGreaterThanOrEqual(50);
    });
  });
}
