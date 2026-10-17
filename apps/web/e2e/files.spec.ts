import { expect, type Page, test } from "@playwright/test";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The PNG bytes of a 3x2 opaque red image, encoded by the browser. */
async function redPng(page: Page): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 3;
    canvas.height = 2;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no 2D context");
    context.fillStyle = "#f00";
    context.fillRect(0, 0, 3, 2);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (blob === null) throw new Error("the canvas did not encode");
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  return Buffer.from(bytes);
}

async function openMenuItem(page: Page, menu: string, item: RegExp) {
  await page.getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

test.beforeEach(async ({ page }) => {
  // Every browser runs the fallback: Chromium's pickers are native dialogs that tests cannot drive,
  // and Firefox and Safari have none (WEB-FILE-01, WEB-FILE-02).
  await page.addInitScript(() => {
    for (const name of ["showOpenFilePicker", "showSaveFilePicker"]) {
      Object.defineProperty(window, name, { value: undefined });
    }
  });
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
});

test("Open uses a file input where the browser has no file pickers (WEB-FILE-01)", async ({
  page,
}) => {
  const png = await redPng(page);
  const chooser = page.waitForEvent("filechooser");
  await openMenuItem(page, "File", /^Open\.\.\./);
  await (await chooser).setFiles({ name: "red.png", mimeType: "image/png", buffer: png });
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.getByRole("tab", { selected: true })).toContainText("red.png");
  await expect(page.locator(".app-status-bar")).toContainText("3 × 2");
});

test("Save As downloads the image under the chosen name without file pickers (WEB-FILE-02)", async ({
  page,
}) => {
  await openMenuItem(page, "File", /^Save As\.\.\./);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  const configuration = page.getByRole("dialog", { name: "Save Configuration" });
  const ok = configuration.getByRole("button", { name: "OK", exact: true });
  await expect(ok).toBeEnabled();
  const download = page.waitForEvent("download");
  await ok.click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.png$/);
  const chunks: Buffer[] = [];
  for await (const chunk of await file.createReadStream()) chunks.push(chunk as Buffer);
  expect([...Buffer.concat(chunks).subarray(0, 8)]).toEqual(PNG_SIGNATURE);
});

test("Copy with a selection writes the PNG, plus the outline where custom types exist (WEB-CLIP-01)", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName === "webkit",
    "WebKit refuses a clipboard write that starts after the asynchronous PNG encode.",
  );
  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  }
  await page.evaluate(() => {
    const scope = window as { clipboardWrites?: string[][] };
    scope.clipboardWrites = [];
    const write = navigator.clipboard.write.bind(navigator.clipboard);
    navigator.clipboard.write = async (items) => {
      await write(items);
      scope.clipboardWrites?.push(items.flatMap((item) => [...item.types]));
    };
  });
  await openMenuItem(page, "Edit", /^Select All/);
  await openMenuItem(page, "Edit", /^Copy Ctrl/);
  const writes = () =>
    page.evaluate(() => (window as { clipboardWrites?: string[][] }).clipboardWrites);
  await expect.poll(writes).toHaveLength(1);
  const [types] = (await writes()) ?? [];
  expect(types).toContain("image/png");
  // Firefox has no custom `web ` types; Chromium writes the outline as one (DOC-CLP-02 item 3).
  if (browserName === "chromium") {
    expect(types).toContain("web application/x-openpaint-selection+json");
  }
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("Copy with a selection and Paste into New Image round-trip through the system clipboard (WEB-CLIP-01, WEB-CLIP-02)", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "Headless Firefox keeps only text on its clipboard, and WebKit refuses the write (see above).",
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openMenuItem(page, "Edit", /^Select All/);
  await openMenuItem(page, "Edit", /^Copy Ctrl/);
  await openMenuItem(page, "Edit", /^Paste into New Image/);
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.locator(".app-status-bar")).toContainText("800 × 600");
});
