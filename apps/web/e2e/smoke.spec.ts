import { expect, test } from "@playwright/test";

test("loads the app shell cross-origin isolated with a service worker", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.headers()["cross-origin-opener-policy"]).toBe("same-origin");
  expect(response?.headers()["cross-origin-embedder-policy"]).toBe("require-corp");

  await expect(page.getByRole("heading", { name: "OpenPaint" })).toBeVisible();
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

  const manifest = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(manifest).toBeTruthy();
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(new URL(scope).pathname).toBe("/");
});
