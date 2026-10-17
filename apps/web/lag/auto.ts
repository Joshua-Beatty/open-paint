/// <reference types="node" />
import type { Page } from "@playwright/test";
import { paceMoves } from "../bench/harness.ts";
import { strokePath } from "../bench/paths.ts";
import type { BenchInfo } from "../src/perf/bench-hook.ts";

const ENGINE_CANVAS = "[data-backend] canvas:not(.app-canvas-overlay)";

async function info(page: Page): Promise<BenchInfo> {
  const result = await page.evaluate(() => window.__openpaintBench?.info());
  if (result === undefined) throw new Error("The page runs without ?bench=1.");
  return result;
}

async function idle(page: Page): Promise<void> {
  await page.evaluate(() => window.__openpaintPerf?.idle(120_000));
}

/**
 * The scripted session of `pnpm lag --auto` (the smoke test): opens a 4000 x 3000 image of 8
 * filled layers, paints one 2.5 s Paintbrush stroke at 120 Hz, then zooms with Ctrl+wheel, waiting
 * for the app to settle after each step.
 */
export async function autoSession(page: Page, log: (line: string) => void): Promise<void> {
  await page.locator("[data-backend]").first().waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => window.__openpaintBench !== undefined);
  log("auto: opening a 4000 x 3000 image with 8 layers");
  const tabs = await page.getByRole("tab").count();
  await page.evaluate(() =>
    window.__openpaintBench?.createDocument({ width: 4000, height: 3000, layers: 8, fill: true }),
  );
  await page.waitForFunction(
    (count) => document.querySelectorAll("[role=tab]").length > count,
    tabs,
  );
  await idle(page);
  await page.getByRole("radio", { name: "Paintbrush", exact: true }).click();
  await page.evaluate(() => window.__openpaintBench?.setBrushSize(100));
  const { layout, devicePixelRatio } = await info(page);
  const box = await page.locator(ENGINE_CANVAS).boundingBox();
  if (layout === undefined || box === null) throw new Error("The canvas has no layout yet.");
  const { points } = strokePath(box, layout, devicePixelRatio, 3000, 300, 48);
  const [first, ...moves] = points;
  if (first === undefined) throw new Error("The stroke has no points.");
  log("auto: painting a stroke");
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  await paceMoves(page, moves, 120);
  await page.mouse.up();
  await idle(page);
  log("auto: zooming with Ctrl+wheel");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down("Control");
  for (let step = 0; step < 6; step++) {
    await page.mouse.wheel(0, step < 3 ? -100 : 100);
    await page.waitForTimeout(80);
  }
  await page.keyboard.up("Control");
  await idle(page);
  await page.waitForTimeout(500);
}
