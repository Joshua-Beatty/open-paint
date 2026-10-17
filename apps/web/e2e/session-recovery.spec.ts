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

test("a reload offers the unsaved image back with its history, and Restore brings it back", async ({
  page,
}) => {
  await openWithOpfs(page);

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

test("Discard asks once more, deletes the checkpoints and opens a new blank image", async ({
  page,
}) => {
  await openWithOpfs(page);
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
