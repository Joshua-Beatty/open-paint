/// <reference types="node" />
import { expect, type Page } from "@playwright/test";
import type { BenchInfo } from "../src/perf/bench-hook.ts";
import type { PerfIdle } from "../src/perf/perf-monitor.ts";
import { type ScenarioMetrics, scenarioMetrics } from "../src/perf/stats.ts";
import type { Box, Point } from "./paths.ts";
import { GestureProfile } from "./profile.ts";

/** The engine the results are filed under, passed to the app as `?engine=`. */
export const ENGINE = process.env.OPENPAINT_ENGINE ?? "v1";

/** Every scenario runs on a 4000 x 3000 image. */
export const DOCUMENT = { width: 4000, height: 3000 } as const;

/** The input rate of a real high-frequency mouse or pen. */
export const INPUT_HZ = 120;

/** How long a document may take to open and render before the scenario gives up on idle. */
export const SETUP_CAP_MS = 5 * 60_000;

/** How long the app may take to settle after a gesture before the result is recorded as capped. */
export const SETTLE_CAP_MS = 3 * 60_000;

const ENGINE_CANVAS = "[data-backend] canvas:not(.app-canvas-overlay)";

/** Opens the built app with the instrumentation and the bench hook, and waits for the engine. */
export async function openApp(page: Page): Promise<void> {
  await page.goto(`/?perf=1&bench=1&engine=${encodeURIComponent(ENGINE)}`);
  await expect(page.getByRole("tab")).toHaveCount(1, { timeout: 60_000 });
  await page.waitForFunction(
    () => window.__openpaintBench !== undefined && window.__openpaintPerf !== undefined,
  );
  await expect(page.locator("[data-backend]")).toHaveAttribute("data-backend", /\w+/);
}

/** Opens a `DOCUMENT`-sized image of `layers` filled layers as a new tab and waits until idle. */
export async function createDocument(page: Page, layers: number): Promise<PerfIdle> {
  await page.evaluate((options) => window.__openpaintBench?.createDocument(options), {
    ...DOCUMENT,
    layers,
    fill: true,
  });
  await expect(page.getByRole("tab")).toHaveCount(2);
  return idle(page, SETUP_CAP_MS);
}

export function idle(page: Page, capMs: number): Promise<PerfIdle> {
  return page.evaluate((timeout) => {
    const perf = window.__openpaintPerf;
    if (perf === undefined) throw new Error("The page runs without ?perf=1.");
    return perf.idle(timeout);
  }, capMs);
}

export async function info(page: Page): Promise<BenchInfo> {
  const result = await page.evaluate(() => window.__openpaintBench?.info());
  if (result === undefined) throw new Error("The page runs without ?bench=1.");
  return result;
}

/** Gives the canvas area focus, so view shortcuts apply, and presses `keys`. */
export async function pressOnCanvas(page: Page, keys: string): Promise<void> {
  await page.locator(".app-canvas-area").focus();
  await page.keyboard.press(keys);
}

/**
 * Fits the image to the window with Ctrl+B. The shortcut toggles between fit and 100 %, so it is
 * pressed only when the view is not fitted already. Waits until the app is idle.
 */
export async function fitToWindow(page: Page): Promise<void> {
  if ((await info(page)).layout?.mode !== "fit") await pressOnCanvas(page, "Control+B");
  await expect.poll(async () => (await info(page)).layout?.mode).toBe("fit");
  await idle(page, SETUP_CAP_MS);
}

/** Sets 100 % with Ctrl+0 and waits until the app is idle. */
export async function actualSize(page: Page): Promise<void> {
  await pressOnCanvas(page, "Control+0");
  await expect.poll(async () => (await info(page)).layout?.zoom).toBe(1);
  await idle(page, SETUP_CAP_MS);
}

export async function canvasBox(page: Page): Promise<Box> {
  const box = await page.locator(ENGINE_CANVAS).boundingBox();
  if (box === null) throw new Error("The engine canvas has no box.");
  return box;
}

let profileName = "gesture";
let profile: GestureProfile | undefined;

/** Names the profile files of the next gestures (`BENCH_PROFILE`). */
export function nameProfile(name: string): void {
  profileName = name;
}

/** Forgets earlier recordings and returns the gesture's start mark. */
export async function beginGesture(page: Page): Promise<number> {
  profile = await GestureProfile.start(page);
  return page.evaluate(() => {
    const perf = window.__openpaintPerf;
    if (perf === undefined) throw new Error("The page runs without ?perf=1.");
    perf.reset();
    return perf.mark("gestureStart");
  });
}

export interface GestureResult {
  readonly metrics: ScenarioMetrics;
  readonly timedOut: boolean;
}

/** Marks the gesture's end, waits until the app is idle (up to the cap) and measures it. */
export async function endGesture(page: Page, from: number): Promise<GestureResult> {
  const to = await page.evaluate(() => window.__openpaintPerf?.mark("gestureEnd") ?? 0);
  const settled = await idle(page, SETTLE_CAP_MS);
  await profile?.stop(profileName);
  profile = undefined;
  const snapshot = await page.evaluate(() => {
    const perf = window.__openpaintPerf;
    if (perf === undefined) throw new Error("The page runs without ?perf=1.");
    return perf.snapshot();
  });
  return {
    metrics: scenarioMetrics(snapshot, {
      from,
      to,
      idleAt: settled.idle ? settled.at : undefined,
    }),
    timedOut: !settled.idle,
  };
}

/**
 * Waits until `due` (a `performance.now()` time of this process). It sleeps while far off and
 * yields in a tight loop near the end, since timers on Windows tick at about 15 ms.
 */
async function waitUntil(due: number): Promise<void> {
  for (;;) {
    const left = due - performance.now();
    if (left <= 0) return;
    if (left > 20) await new Promise((resolve) => setTimeout(resolve, left - 16));
    else await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Sends `points` as mouse moves at `hz`. Like a real device, it does not wait for the page to
 * handle one move before sending the next; the browser coalesces moves while its main thread is
 * busy. Returns the time the moves took to send, in milliseconds.
 */
export async function paceMoves(page: Page, points: readonly Point[], hz: number): Promise<number> {
  const interval = 1000 / hz;
  const start = performance.now();
  const sent: Promise<void>[] = [];
  for (const [index, point] of points.entries()) {
    await waitUntil(start + index * interval);
    sent.push(page.mouse.move(point.x, point.y));
  }
  await Promise.all(sent);
  return performance.now() - start;
}

/**
 * Sends `points` as pointer moves on the engine canvas, one at the start of each animation frame,
 * the way a browser delivers mouse input: coalesced per frame and dispatched just before the frame
 * renders. `buttons` is the held buttons mask (4 for the middle button). The pointer must already
 * be down, so it holds the capture. Returns the time the moves took, in milliseconds.
 */
export function frameAlignedMoves(
  page: Page,
  points: readonly Point[],
  buttons: number,
): Promise<number> {
  return page.evaluate(
    ({ points, buttons, selector }) =>
      new Promise<number>((resolve) => {
        const canvas = document.querySelector(selector);
        const start = performance.now();
        let index = 0;
        const step = () => {
          const point = points[index];
          if (canvas === null || point === undefined) {
            resolve(performance.now() - start);
            return;
          }
          index += 1;
          canvas.dispatchEvent(
            new PointerEvent("pointermove", {
              bubbles: true,
              cancelable: true,
              composed: true,
              clientX: point.x,
              clientY: point.y,
              pointerId: 1,
              pointerType: "mouse",
              isPrimary: true,
              buttons,
            }),
          );
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    { points, buttons, selector: ENGINE_CANVAS },
  );
}

/** Presses each of `keys` in turn, `intervalMs` apart. */
export async function paceKeys(page: Page, keys: readonly string[], intervalMs: number) {
  const start = performance.now();
  for (const [index, key] of keys.entries()) {
    await waitUntil(start + index * intervalMs);
    await page.keyboard.press(key);
  }
}

/** The titles of the entries in the app's local error log (SET-ERR-01). */
export function errorLogTitles(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const open = indexedDB.open("openpaint-diagnostics");
        open.onerror = () => resolve([]);
        open.onsuccess = () => {
          const database = open.result;
          if (!database.objectStoreNames.contains("errorLog")) {
            resolve([]);
            return;
          }
          const request = database.transaction("errorLog").objectStore("errorLog").getAll();
          request.onerror = () => resolve([]);
          request.onsuccess = () =>
            resolve((request.result as { title: string }[]).map((entry) => entry.title));
        };
      }),
  );
}

/** The name of the newest history item. */
export function lastHistoryItem(page: Page) {
  return page.locator("ol.app-history-list li:last-child .app-history-name");
}
