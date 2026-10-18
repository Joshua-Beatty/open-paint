import { expect, type Page, test } from "@playwright/test";

/**
 * The number of finished session checkpoints in the origin's OPFS folder (WEB-MEM-05). A checkpoint
 * counts once its manifest is written, since the manifest is the last file of a write.
 */
function checkpointCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    let count = 0;
    try {
      const session = await root.getDirectoryHandle("openpaint-session");
      for await (const owner of session.values()) {
        if (owner.kind !== "directory") continue;
        for await (const entry of (owner as FileSystemDirectoryHandle).values()) {
          if (entry.kind !== "directory") continue;
          try {
            await (entry as FileSystemDirectoryHandle).getFileHandle("manifest.json");
            count++;
          } catch {
            // A checkpoint still being written has no manifest yet.
          }
        }
      }
    } catch {
      return 0;
    }
    return count;
  });
}

/**
 * Opens the app and skips the test when this browser cannot open OPFS. Session checkpoints live in
 * OPFS (WEB-MEM-05), so there is nothing to recover without it. Playwright's WebKit rejects
 * `getDirectory()` with an UnknownError, and the app then runs without checkpoints.
 */
async function openWithOpfs(page: Page): Promise<void> {
  await page.goto("/");
  const available = await page.evaluate(async () => {
    try {
      await navigator.storage.getDirectory();
      return true;
    } catch {
      return false;
    }
  });
  test.skip(!available, "This browser cannot open OPFS, so session checkpoints are not kept.");
  await expect(page.getByRole("tab")).toHaveCount(1);
}

/** The Settings checkbox that turns session recovery on (owner request: off by default). */
const RECOVERY_SETTING = "Restore unsaved images after the tab closes or crashes";

/** Turns session recovery on or off in Settings > User Interface. */
async function setRecovery(page: Page, on: boolean): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("option", { name: "User Interface" }).click();
  const box = dialog.getByRole("checkbox", { name: RECOVERY_SETTING });
  // The checkbox's label covers its input, so the label takes the click, as it does for a user.
  if ((await box.isChecked()) !== on) {
    await dialog.locator("label.react-aria-Checkbox", { hasText: RECOVERY_SETTING }).click();
  }
  await expect(box).toBeChecked({ checked: on });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
}

/** Whether the page's beforeunload handlers would ask the user before leaving (WEB-UI-06). */
function asksBeforeLeaving(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

test("by default nothing is kept for recovery: a reload after drawing offers nothing", async ({
  page,
}) => {
  await openWithOpfs(page);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await expect(page).toHaveTitle("*Untitled - OpenPaint");
  // Longer than the checkpoint delay, so a checkpoint would have been written by now.
  await page.waitForTimeout(2500);
  expect(await checkpointCount(page)).toBe(0);

  await page.reload();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.getByRole("dialog", { name: "Restore Session" })).toHaveCount(0);
  await expect(page).toHaveTitle("Untitled - OpenPaint");
});

test("a selection on the blank start image is not unsaved work: no leave prompt", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  await page.keyboard.press("Control+A");
  await expect(page.getByRole("button", { name: "Deselect" }).first()).toBeEnabled();
  await expect(page).toHaveTitle("Untitled - OpenPaint");
  expect(await asksBeforeLeaving(page)).toBe(false);
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  await page.reload();
  await expect(page.getByRole("tab")).toHaveCount(1);
  expect(dialogs).toEqual([]);

  // A real edit does ask.
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await expect(page).toHaveTitle("*Untitled - OpenPaint");
  expect(await asksBeforeLeaving(page)).toBe(true);
});

test("with recovery on, a reload after only a selection on the blank start image offers nothing", async ({
  page,
}) => {
  await openWithOpfs(page);
  await setRecovery(page, true);
  await expect(page).toHaveTitle("Untitled - OpenPaint");
  await page.keyboard.press("Control+A");
  await expect(page.getByRole("button", { name: "Deselect" }).first()).toBeEnabled();
  // Longer than the checkpoint delay, so a checkpoint would have been written by now.
  await page.waitForTimeout(2500);
  expect(await checkpointCount(page)).toBe(0);

  await page.reload();
  // The start image opens only once the app has found nothing to offer.
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.getByRole("dialog", { name: "Restore Session" })).toHaveCount(0);
  await expect(page).toHaveTitle("Untitled - OpenPaint");
});

test("with recovery on, a reload offers the unsaved image back with its history, and Restore brings it back", async ({
  page,
}) => {
  await openWithOpfs(page);
  await setRecovery(page, true);

  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await expect(page).toHaveTitle("*Untitled - OpenPaint");
  await expect.poll(() => checkpointCount(page)).toBeGreaterThan(0);

  await page.reload();
  const offer = page.getByRole("dialog", { name: "Restore Session" });
  await expect(offer).toBeVisible();
  await expect(offer).toContainText("Restore 1 image from your last session?");
  await offer.getByRole("button", { name: "Restore", exact: true }).click();

  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page).toHaveTitle("*Untitled - OpenPaint");

  // Delete is Select All plus Erase Selection, so two steps reach the saved position.
  await page.keyboard.press("Control+Z");
  await expect(page).toHaveTitle("*Untitled - OpenPaint");
  await page.keyboard.press("Control+Z");
  await expect(page).toHaveTitle("Untitled - OpenPaint");
});

test("with recovery on, Discard asks once more, deletes the checkpoints and opens a new blank image", async ({
  page,
}) => {
  await openWithOpfs(page);
  await setRecovery(page, true);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await expect.poll(() => checkpointCount(page)).toBeGreaterThan(0);

  await page.reload();
  const offer = page.getByRole("dialog", { name: "Restore Session" });
  await expect(offer).toBeVisible();
  await offer.getByRole("button", { name: "Discard", exact: true }).click();
  await offer.getByRole("button", { name: "Discard", exact: true }).click();

  await expect(offer).toHaveCount(0);
  // A new default image opens instead of the discarded one, unchanged and with no history.
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page).toHaveTitle("Untitled - OpenPaint");
  await expect.poll(() => checkpointCount(page)).toBe(0);
});

test("turning recovery off deletes the checkpoints, and a reload then offers nothing", async ({
  page,
}) => {
  await openWithOpfs(page);
  await setRecovery(page, true);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await expect.poll(() => checkpointCount(page)).toBeGreaterThan(0);

  await setRecovery(page, false);
  await expect.poll(() => checkpointCount(page)).toBe(0);
  await page.reload();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.getByRole("dialog", { name: "Restore Session" })).toHaveCount(0);
  await expect(page).toHaveTitle("Untitled - OpenPaint");
});
