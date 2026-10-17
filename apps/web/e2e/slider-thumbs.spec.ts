import { expect, type Locator, test } from "@playwright/test";

/** The thumb's centre against the track's: vertical offset, and horizontal offset from `value`. */
async function thumbOffset(track: Locator) {
  return track.evaluate((element) => {
    const thumb = element.querySelector(":scope > div");
    if (thumb === null) throw new Error("no thumb");
    const own = element.getBoundingClientRect();
    const box = thumb.getBoundingClientRect();
    const input = thumb.querySelector("input");
    const min = Number(input?.min ?? 0);
    const max = Number(input?.max ?? 100);
    const fraction = (Number(input?.value ?? 0) - min) / (max - min);
    const style = getComputedStyle(element);
    const left = own.left + Number.parseFloat(style.borderLeftWidth);
    const width = element.clientWidth;
    return {
      dy: box.top + box.height / 2 - (own.top + own.height / 2),
      dx: box.left + box.width / 2 - (left + fraction * width),
    };
  });
}

test("slider thumbs sit centred on their tracks, at their value", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(1);
  const zoom = await thumbOffset(page.locator(".app-status-slider-track"));
  expect(Math.abs(zoom.dy)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(zoom.dx)).toBeLessThanOrEqual(0.5);

  await page.getByRole("button", { name: "More >>" }).click();
  const tracks = page.locator(".color-slider-track");
  await expect(tracks).toHaveCount(7);
  for (const track of await tracks.all()) {
    const offset = await thumbOffset(track);
    expect(Math.abs(offset.dy)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(offset.dx)).toBeLessThanOrEqual(0.5);
  }

  // Layer Properties' opacity slider has a visible track and thumb, centred the same way.
  await page.getByRole("button", { name: "Layer Properties", exact: true }).click();
  const opacity = page.getByRole("dialog").locator(".app-slider-track");
  const size = await opacity.evaluate((element) => {
    const thumb = element.querySelector(":scope > div")?.getBoundingClientRect();
    return { track: element.getBoundingClientRect().width, thumb: thumb?.width ?? 0 };
  });
  expect(size.track).toBeGreaterThan(100);
  expect(size.thumb).toBeGreaterThan(10);
  const offset = await thumbOffset(opacity);
  expect(Math.abs(offset.dy)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(offset.dx)).toBeLessThanOrEqual(0.5);
});
