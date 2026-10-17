import { expect, type Page, test } from "@playwright/test";
import { BENCH_BROWSER } from "./browser.ts";
import {
  actualSize,
  beginGesture,
  canvasBox,
  createDocument,
  endGesture,
  errorLogTitles,
  fitToWindow,
  frameAlignedMoves,
  type GestureResult,
  INPUT_HZ,
  idle,
  info,
  lastHistoryItem,
  nameProfile,
  openApp,
  paceKeys,
  paceMoves,
  pressOnCanvas,
  SETUP_CAP_MS,
} from "./harness.ts";
import {
  circlePath,
  cssToImage,
  dragPath,
  imageToCss,
  linePath,
  panPath,
  scribblePath,
  sliderPath,
  sliderSweepPath,
  spiralPath,
  strokePath,
  visibleImage,
} from "./paths.ts";
import type { ScenarioResult } from "./report.ts";
import { saveScenario } from "./store.ts";

/**
 * The benchmark scenarios. Each runs in a fresh page and saves its own
 * result, so one failing or timing out does not lose the others. The global teardown gathers them
 * into `.perf/results/<engine>-<date>.json` and prints the table.
 */

type Setup = Record<string, number | string | boolean>;

/** B1-B3: about 300 moves for a 3000 px stroke, sent at 120 Hz (2.5 s). */
const STROKE_IMAGE_PX = 3000;
const STROKE_MOVES = 300;
const BRUSH_PX = 100;
/** Keeps the pointer clear of the 24 px auto-scroll band at the canvas edges. */
const STROKE_MARGIN_CSS = 48;
/** B4 and B6: 2 s gestures at 120 Hz. */
const DRAG_MOVES = 240;
/** B5: one zoom step every 100 ms. */
const ZOOM_STEPS = 10;
const ZOOM_STEP_MS = 100;
/** B6: the Radius slider is dragged one way across this part of its track. */
const SLIDER_FROM = 0.02;
const SLIDER_TO = 0.25;

function scenario(
  id: string,
  title: string,
  run: (page: Page, setup: Setup, notes: string[]) => Promise<GestureResult>,
) {
  test(`${id}: ${title}`, async ({ page, browser }) => {
    nameProfile(id);
    const setup: Setup = {};
    const browserName = `${BENCH_BROWSER} ${browser.version()}`;
    // Replaced below. It stays if the test is killed by its timeout.
    saveScenario({
      result: {
        id,
        title,
        setup,
        metrics: null,
        timedOut: true,
        error: "did not finish (test timeout)",
      },
      browser: browserName,
      backend: undefined,
      adapter: undefined,
      devicePixelRatio: 1,
    });
    const notes: string[] = [];
    let result: ScenarioResult;
    try {
      await openApp(page);
      const gesture = await run(page, setup, notes);
      if (gesture.metrics.presents === 0) notes.push("nothing was presented during the gesture");
      if (gesture.busy !== undefined) notes.push(`still busy: ${gesture.busy.join(", ")}`);
      const previews = gesture.metrics.previewLatency;
      if (previews.count > 0) {
        const ms = (value: number | null) => (value === null ? "-" : value.toFixed(0));
        notes.push(
          `previews shown ${gesture.metrics.previewsPerSecond.toFixed(1)}/s, time to visible update p50/p95/max ${ms(previews.p50)}/${ms(previews.p95)}/${ms(previews.max)} ms over ${previews.count}`,
        );
      }
      for (const title of await errorLogTitles(page)) notes.push(`app error: ${title}`);
      result = {
        id,
        title,
        setup,
        metrics: gesture.metrics,
        frames: gesture.frames,
        timedOut: gesture.timedOut,
        notes,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { id, title, setup, metrics: null, timedOut: false, error: message.split("\n")[0] };
    }
    const environment = await info(page).catch(() => undefined);
    saveScenario({
      result,
      browser: browserName,
      backend: (await page.locator("[data-backend]").getAttribute("data-backend")) ?? undefined,
      adapter: environment?.adapter,
      devicePixelRatio: environment?.devicePixelRatio ?? 1,
      engine: environment?.engine,
      crossOriginIsolated: environment?.crossOriginIsolated,
      hardwareConcurrency: environment?.hardwareConcurrency,
      userAgent: environment?.userAgent,
    });
    expect(result.error).toBeUndefined();
  });
}

/**
 * Effects › Blurs › Gaussian Blur. The submenu is opened with a click: Playwright's bundled
 * Firefox does not open it on hover.
 */
async function openGaussianBlur(page: Page) {
  await page.getByRole("button", { name: "Effects", exact: true }).click();
  await page.getByRole("menuitem", { name: /Blurs/ }).click();
  await page.getByRole("menuitem", { name: /^Gaussian Blur/ }).click();
}

/**
 * The engine's layout and its device pixels per CSS pixel, measured from the engine canvas: the
 * window's `devicePixelRatio` can disagree with the canvas (desktop Firefox on a high-DPI screen).
 */
async function zoomedLayout(page: Page) {
  const { layout } = await info(page);
  if (layout === undefined) throw new Error("The engine has not reported a view layout.");
  const devicePixelRatio = await page
    .locator("[data-backend] canvas:not(.app-canvas-overlay)")
    .evaluate((canvas: HTMLCanvasElement) => canvas.width / canvas.getBoundingClientRect().width);
  return { layout, devicePixelRatio };
}

/** B1-B3: one Paintbrush stroke with a 100 px brush, at the zoom `zoom` sets. */
async function stroke(
  page: Page,
  setup: Setup,
  notes: string[],
  layers: number,
  zoom: (page: Page) => Promise<void>,
) {
  setup.layers = layers;
  setup.openSettled = (await createDocument(page, layers)).idle;
  await page.getByRole("radio", { name: "Paintbrush", exact: true }).click();
  await page.evaluate((size) => window.__openpaintBench?.setBrushSize(size), BRUSH_PX);
  await zoom(page);
  const { layout, devicePixelRatio } = await zoomedLayout(page);
  const path = strokePath(
    await canvasBox(page),
    layout,
    devicePixelRatio,
    STROKE_IMAGE_PX,
    STROKE_MOVES,
    STROKE_MARGIN_CSS,
  );
  Object.assign(setup, {
    zoom: layout.zoom,
    brushPx: BRUSH_PX,
    strokeImagePx: Math.round(path.imageLength),
    moves: STROKE_MOVES,
    inputHz: INPUT_HZ,
  });
  const [first, ...moves] = path.points;
  if (first === undefined) throw new Error("The stroke has no points.");
  await page.mouse.move(first.x, first.y);
  const from = await beginGesture(page);
  await page.mouse.down();
  setup.sendMs = Math.round(await paceMoves(page, moves, INPUT_HZ));
  await page.mouse.up();
  const result = await endGesture(page, from);
  const step = (await lastHistoryItem(page).textContent()) ?? "";
  setup.historyStep = step;
  if (step !== "Paintbrush") notes.push(`the stroke was not recorded (last history item: ${step})`);
  return result;
}

scenario("B1", "Paintbrush 100 px, 3000 px stroke at 100 %", (page, setup, notes) =>
  stroke(page, setup, notes, 1, actualSize),
);

scenario("B2", "Paintbrush 100 px, 3000 px stroke at fit-to-window", (page, setup, notes) =>
  stroke(page, setup, notes, 1, fitToWindow),
);

scenario("B3", "B2 with 20 filled layers", (page, setup, notes) =>
  stroke(page, setup, notes, 20, fitToWindow),
);

scenario("B4", "Pan zoomed out, 20 layers, 2 s middle-button drag", async (page, setup) => {
  setup.layers = 20;
  setup.openSettled = (await createDocument(page, 20)).idle;
  await fitToWindow(page);
  await page.locator(".app-canvas-area").focus();
  // Fit mode always shows the whole image and cannot pan, so step in from fit until the image
  // overflows the canvas both ways. It stays zoomed out, which is what this scenario measures.
  const box = await canvasBox(page);
  for (let step = 0; step < 6; step++) {
    const { layout, devicePixelRatio } = await zoomedLayout(page);
    const overflows =
      layout.documentWidth * layout.zoom > box.width * devicePixelRatio &&
      layout.documentHeight * layout.zoom > box.height * devicePixelRatio;
    if (overflows) break;
    await page.keyboard.press("Control+Equal");
    await idle(page, SETUP_CAP_MS);
  }
  const { layout } = await zoomedLayout(page);
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const [first, ...moves] = panPath(center, 150, DRAG_MOVES);
  Object.assign(setup, { zoom: layout.zoom, moves: DRAG_MOVES, inputHz: INPUT_HZ });
  if (first === undefined) throw new Error("The pan has no points.");
  await page.mouse.move(first.x, first.y);
  const from = await beginGesture(page);
  await page.mouse.down({ button: "middle" });
  setup.sendMs = Math.round(await paceMoves(page, moves, INPUT_HZ));
  await page.mouse.up({ button: "middle" });
  return endGesture(page, from);
});

scenario("B5", "Zoom in and out x10 steps, 20 layers", async (page, setup) => {
  setup.layers = 20;
  setup.openSettled = (await createDocument(page, 20)).idle;
  await fitToWindow(page);
  await page.locator(".app-canvas-area").focus();
  const keys = [
    ...Array<string>(ZOOM_STEPS).fill("Control+Equal"),
    ...Array<string>(ZOOM_STEPS).fill("Control+Minus"),
  ];
  Object.assign(setup, { steps: keys.length, stepMs: ZOOM_STEP_MS });
  const from = await beginGesture(page);
  await paceKeys(page, keys, ZOOM_STEP_MS);
  return endGesture(page, from);
});

scenario(
  "B6",
  "Gaussian Blur live preview, Radius slider dragged for 2 s, 1 layer",
  async (page, setup) => {
    setup.layers = 1;
    setup.openSettled = (await createDocument(page, 1)).idle;
    await fitToWindow(page);
    await openGaussianBlur(page);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    setup.firstPreviewSettled = (await idle(page, SETUP_CAP_MS)).idle;
    const thumb = dialog.getByRole("slider", { name: "Radius", exact: true });
    const track = await thumb.locator("..").boundingBox();
    if (track === null) throw new Error("The Radius slider has no track.");
    const [first, ...moves] = sliderPath(track, SLIDER_FROM, SLIDER_TO, DRAG_MOVES);
    Object.assign(setup, {
      radiusMin: Number(await thumb.getAttribute("aria-valuemin")),
      radiusMax: Number(await thumb.getAttribute("aria-valuemax")),
      sliderFrom: SLIDER_FROM,
      sliderTo: SLIDER_TO,
      moves: DRAG_MOVES,
      inputHz: INPUT_HZ,
    });
    if (first === undefined) throw new Error("The drag has no points.");
    await page.mouse.move(first.x, first.y);
    const from = await beginGesture(page);
    await page.mouse.down();
    setup.sendMs = Math.round(await paceMoves(page, moves, INPUT_HZ));
    await page.mouse.up();
    const result = await endGesture(page, from);
    setup.radiusAfter = Number(await thumb.getAttribute("aria-valuenow"));
    await page.keyboard.press("Escape");
    return result;
  },
);

/** B7: a long, small-brush stroke that circles back over itself, on the default first-launch image. */
const SPIRAL_TURNS = 8;
const SPIRAL_MOVES = Number(process.env.SPIRAL_MOVES ?? 1200);
const SPIRAL_BRUSH_PX = 5;

scenario(
  "B7",
  "Paintbrush 5 px, 8-turn spiral (1200 moves, 10 s) on the default image",
  async (page, setup, notes) => {
    await fitToWindow(page);
    await page.getByRole("radio", { name: "Paintbrush", exact: true }).click();
    await page.evaluate((size) => window.__openpaintBench?.setBrushSize(size), SPIRAL_BRUSH_PX);
    const { layout, devicePixelRatio } = await zoomedLayout(page);
    const [first, ...moves] = spiralPath(
      await canvasBox(page),
      layout,
      devicePixelRatio,
      SPIRAL_TURNS,
      SPIRAL_MOVES,
    );
    Object.assign(setup, {
      document: `${layout.documentWidth}x${layout.documentHeight}`,
      zoom: layout.zoom,
      brushPx: SPIRAL_BRUSH_PX,
      turns: SPIRAL_TURNS,
      moves: SPIRAL_MOVES,
      inputHz: INPUT_HZ,
    });
    if (first === undefined) throw new Error("The spiral has no points.");
    await page.mouse.move(first.x, first.y);
    const from = await beginGesture(page);
    await page.mouse.down();
    setup.sendMs = Math.round(await paceMoves(page, moves, INPUT_HZ));
    await page.mouse.up();
    const result = await endGesture(page, from);
    const step = (await lastHistoryItem(page).textContent()) ?? "";
    setup.historyStep = step;
    if (step !== "Paintbrush")
      notes.push(`the stroke was not recorded (last history item: ${step})`);
    return result;
  },
);

/** B8: dragging a whole-image selection with Move Selected Pixels, 2 s at 120 Hz. */
const MOVE_DRAG_CSS = { x: 240, y: 120 };

scenario(
  "B8",
  "Move Selected Pixels, Select All on 1 layer, 2 s drag at fit-to-window",
  async (page, setup, notes) => {
    setup.layers = 1;
    setup.openSettled = (await createDocument(page, 1)).idle;
    await fitToWindow(page);
    await pressOnCanvas(page, "Control+A");
    await idle(page, SETUP_CAP_MS);
    await page.getByRole("radio", { name: "Move Selected Pixels", exact: true }).click();
    const { layout } = await zoomedLayout(page);
    const box = await canvasBox(page);
    // Off the centre, where the rotation anchor sits, so the press moves the pixels.
    const press = { x: box.x + box.width * 0.35, y: box.y + box.height * 0.35 };
    const [first, ...moves] = dragPath(press, MOVE_DRAG_CSS, DRAG_MOVES);
    Object.assign(setup, {
      zoom: layout.zoom,
      selection: "all",
      dragCss: `${MOVE_DRAG_CSS.x},${MOVE_DRAG_CSS.y}`,
      moves: DRAG_MOVES,
      inputHz: INPUT_HZ,
    });
    if (first === undefined) throw new Error("The drag has no points.");
    await page.mouse.move(first.x, first.y);
    const from = await beginGesture(page);
    await page.mouse.down();
    setup.sendMs = Math.round(await paceMoves(page, moves, INPUT_HZ));
    await page.mouse.up();
    const result = await endGesture(page, from);
    const step = (await lastHistoryItem(page).textContent()) ?? "";
    setup.historyStep = step;
    if (step !== "Move Pixels")
      notes.push(`the move was not recorded (last history item: ${step})`);
    return result;
  },
);

/**
 * B17: rotating a whole-image selection with Move Selected Pixels, 2 s at 120 Hz. The press is just
 * right of the frame (the rotate zone), and the drag sweeps 30 degrees
 * around the image's center, so every frame resamples the whole layer.
 */
scenario(
  "B17",
  "Move Selected Pixels rotate, Select All on 1 layer, 2 s drag at fit-to-window",
  async (page, setup, notes) => {
    setup.layers = 1;
    setup.openSettled = (await createDocument(page, 1)).idle;
    await fitToWindow(page);
    await pressOnCanvas(page, "Control+A");
    await idle(page, SETUP_CAP_MS);
    await page.getByRole("radio", { name: "Move Selected Pixels", exact: true }).click();
    const { layout, devicePixelRatio } = await zoomedLayout(page);
    const box = await canvasBox(page);
    const image = visibleImage(box, layout, devicePixelRatio);
    const center = { x: image.x + image.width / 2, y: image.y + image.height / 2 };
    // Fit leaves room beside the image, not above or below it: the press is right of its middle.
    const start = { x: image.x + image.width + 8, y: center.y };
    const radius = Math.hypot(start.x - center.x, start.y - center.y);
    const from = Math.atan2(start.y - center.y, start.x - center.x);
    const moves = Array.from({ length: DRAG_MOVES }, (_, index) => {
      const angle = from + ((Math.PI / 6) * (index + 1)) / DRAG_MOVES;
      return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
    });
    Object.assign(setup, {
      zoom: layout.zoom,
      selection: "all",
      turn: "30 degrees",
      moves: DRAG_MOVES,
      inputHz: INPUT_HZ,
    });
    await page.mouse.move(start.x, start.y);
    const begin = await beginGesture(page);
    await page.mouse.down();
    setup.sendMs = Math.round(await paceMoves(page, moves, INPUT_HZ));
    await page.mouse.up();
    const result = await endGesture(page, begin);
    const step = (await lastHistoryItem(page).textContent()) ?? "";
    setup.historyStep = step;
    if (step !== "Rotate Pixels")
      notes.push(`the rotation was not recorded (last history item: ${step})`);
    return result;
  },
);

/** B9 and B10: fast circles, 3 s at 120 Hz. */
const CIRCLE_MOVES = 360;
const CIRCLE_TURNS = 6;

/** Opens the image a B9/B10 variant runs on: the default image, or a 4000 x 3000 one. */
async function openImage(page: Page, setup: Setup, large: boolean) {
  if (large) setup.openSettled = (await createDocument(page, 1)).idle;
  await fitToWindow(page);
  const { layout, devicePixelRatio } = await zoomedLayout(page);
  setup.document = `${layout.documentWidth}x${layout.documentHeight}`;
  setup.zoom = layout.zoom;
  return { layout, devicePixelRatio, box: await canvasBox(page) };
}

/**
 * B9: Shapes (default options: a rectangle outline). The drag starts at the image's top-left
 * corner, goes to the bottom-right quarter of the canvas, and then circles there with the button
 * held, resizing the shape on every frame.
 */
async function shapeResize(page: Page, setup: Setup, notes: string[], large: boolean) {
  const { layout, devicePixelRatio, box } = await openImage(page, setup, large);
  await page.getByRole("radio", { name: "Shapes", exact: true }).click();
  const image = visibleImage(box, layout, devicePixelRatio);
  const start = { x: image.x + 8, y: image.y + 8 };
  const center = { x: box.x + box.width * 0.75, y: box.y + box.height * 0.75 };
  const radius = Math.min(box.width, box.height) * 0.15;
  const moves = [
    ...linePath(start, { x: center.x + radius, y: center.y }, 30),
    ...circlePath(center, radius, CIRCLE_TURNS, CIRCLE_MOVES).slice(1),
  ];
  Object.assign(setup, { moves: moves.length, turns: CIRCLE_TURNS, inputHz: INPUT_HZ });
  await page.mouse.move(start.x, start.y);
  const from = await beginGesture(page);
  await page.mouse.down();
  setup.sendMs = Math.round(await paceMoves(page, moves, INPUT_HZ));
  await page.mouse.up();
  const result = await endGesture(page, from);
  const step = (await lastHistoryItem(page).textContent()) ?? "";
  setup.historyStep = step;
  if (!step.startsWith("Draw"))
    notes.push(`the shape was not recorded (last history item: ${step})`);
  return result;
}

scenario("B9a", "Shapes resize in fast circles, default image", (page, setup, notes) =>
  shapeResize(page, setup, notes, false),
);

scenario("B9b", "Shapes resize in fast circles, 4000 x 3000", (page, setup, notes) =>
  shapeResize(page, setup, notes, true),
);

/**
 * B9c: Shapes rotate on 4000 x 3000. A rectangle outline over the middle 60 % of the image is
 * drawn, and then the area just right of it is dragged in fast circles about its centre, turning
 * the pending shape on every frame (TL-SHAPE-01 transform frame).
 */
async function shapeRotate(page: Page, setup: Setup, notes: string[]) {
  const { layout, devicePixelRatio, box } = await openImage(page, setup, true);
  await page.getByRole("radio", { name: "Shapes", exact: true }).click();
  const image = visibleImage(box, layout, devicePixelRatio);
  const a = { x: image.x + image.width * 0.2, y: image.y + image.height * 0.2 };
  const b = { x: image.x + image.width * 0.8, y: image.y + image.height * 0.8 };
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await paceMoves(page, linePath(a, b, 20), INPUT_HZ);
  await page.mouse.up();
  await idle(page, SETUP_CAP_MS);
  // 10 CSS px right of the east handle: the rotate band, clear of the handle.
  const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const radius = b.x - center.x + 10;
  // A quarter turn more than the circles, so the shape ends turned and the rotation is recorded.
  const turns = CIRCLE_TURNS + 0.25;
  const moves = Math.round((CIRCLE_MOVES * turns) / CIRCLE_TURNS);
  const circles = circlePath(center, radius, turns, moves).slice(1);
  Object.assign(setup, { moves: circles.length, turns: CIRCLE_TURNS, inputHz: INPUT_HZ });
  await page.mouse.move(center.x + radius, center.y);
  const from = await beginGesture(page);
  await page.mouse.down();
  setup.sendMs = Math.round(await paceMoves(page, circles, INPUT_HZ));
  await page.mouse.up();
  const result = await endGesture(page, from);
  const step = (await lastHistoryItem(page).textContent()) ?? "";
  setup.historyStep = step;
  if (!step.startsWith("Adjust"))
    notes.push(`the rotation was not recorded (last history item: ${step})`);
  return result;
}

scenario("B9c", "Shapes rotate in fast circles, 4000 x 3000", (page, setup, notes) =>
  shapeRotate(page, setup, notes),
);

/**
 * B10: Line / Curve. A line across the middle of the image is drawn, and then its first control
 * handle is dragged in fast circles for 3 s, bending the curve on every frame.
 */
async function curveDrag(page: Page, setup: Setup, notes: string[], large: boolean) {
  const { layout, devicePixelRatio, box } = await openImage(page, setup, large);
  await page.getByRole("radio", { name: "Line / Curve", exact: true }).click();
  const image = visibleImage(box, layout, devicePixelRatio);
  const y = image.y + image.height / 2;
  const a = { x: image.x + image.width * 0.2, y };
  const b = { x: image.x + image.width * 0.8, y };
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await paceMoves(page, linePath(a, b, 20), INPUT_HZ);
  await page.mouse.up();
  await idle(page, SETUP_CAP_MS);
  // The first control sits a third of the way along the line between its pixel-centered ends.
  const snap = (point: { x: number; y: number }) => {
    const at = cssToImage(box, layout, devicePixelRatio, point);
    return { x: Math.floor(at.x) + 0.5, y: Math.floor(at.y) + 0.5 };
  };
  const start = snap(a);
  const end = snap(b);
  const control = imageToCss(box, layout, devicePixelRatio, {
    x: start.x + (end.x - start.x) / 3,
    y: start.y + (end.y - start.y) / 3,
  });
  const radius = Math.min(image.width, image.height) * 0.3;
  const circles = circlePath(
    { x: control.x - radius, y: control.y },
    radius,
    CIRCLE_TURNS,
    CIRCLE_MOVES,
  ).slice(1);
  Object.assign(setup, { moves: circles.length, turns: CIRCLE_TURNS, inputHz: INPUT_HZ });
  await page.mouse.move(control.x, control.y);
  const from = await beginGesture(page);
  await page.mouse.down();
  setup.sendMs = Math.round(await paceMoves(page, circles, INPUT_HZ));
  await page.mouse.up();
  const result = await endGesture(page, from);
  const step = (await lastHistoryItem(page).textContent()) ?? "";
  setup.historyStep = step;
  if (step !== "Edit Line / Curve")
    notes.push(`the curve edit was not recorded (last history item: ${step})`);
  return result;
}

scenario(
  "B10a",
  "Line / Curve control dragged in fast circles, default image",
  (page, setup, notes) => curveDrag(page, setup, notes, false),
);

scenario(
  "B10b",
  "Line / Curve control dragged in fast circles, 4000 x 3000",
  (page, setup, notes) => curveDrag(page, setup, notes, true),
);

/** B11: a fast pan zoomed in, with the selection outline on screen. */
const PAN_ZOOM = 4;
const FAST_PAN_CSS = 300;

scenario(
  "B11",
  "Selection outline during a fast pan at 400 %, default image, 2 s middle-button drag",
  async (page, setup, notes) => {
    await fitToWindow(page);
    await pressOnCanvas(page, "Control+A");
    for (let step = 0; step < 12; step++) {
      if ((await zoomedLayout(page)).layout.zoom >= PAN_ZOOM) break;
      await page.keyboard.press("Control+Equal");
      await idle(page, SETUP_CAP_MS);
    }
    const { layout } = await zoomedLayout(page);
    const box = await canvasBox(page);
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const [first, ...moves] = panPath(center, FAST_PAN_CSS, DRAG_MOVES);
    Object.assign(setup, {
      zoom: layout.zoom,
      selection: "all",
      moves: DRAG_MOVES,
      panCss: FAST_PAN_CSS,
      input: "one move per frame",
    });
    if (first === undefined) throw new Error("The pan has no points.");
    await page.mouse.move(first.x, first.y);
    await page.evaluate(() => window.__openpaintPerf?.trackFrames(true));
    const from = await beginGesture(page);
    await page.mouse.down({ button: "middle" });
    setup.sendMs = Math.round(await frameAlignedMoves(page, moves, 4));
    await page.mouse.up({ button: "middle" });
    const result = await endGesture(page, from);
    await page.evaluate(() => window.__openpaintPerf?.trackFrames(false));
    const frames = result.metrics.overlayLagFrames;
    const lag = result.metrics.overlayLag;
    if (lag.count === 0) {
      notes.push("no overlay draw was recorded");
    } else {
      const ms = (value: number | null) => (value === null ? "-" : value.toFixed(1));
      notes.push(
        `overlay lag behind the canvas p50/p95/max ${ms(lag.p50)}/${ms(lag.p95)}/${ms(lag.max)} ms, ${frames.p50}/${frames.p95}/${frames.max} frames over ${lag.count} views`,
      );
    }
    return result;
  },
);

/** B12: Gaussian Blur at its default values, committed with OK once its preview is shown. */
async function effectCommit(page: Page, setup: Setup, notes: string[], large: boolean) {
  await openImage(page, setup, large);
  await openGaussianBlur(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  setup.previewSettled = (await idle(page, SETUP_CAP_MS)).idle;
  const ok = dialog.getByRole("button", { name: "OK", exact: true });
  const box = await ok.boundingBox();
  if (box === null) throw new Error("The OK button has no box.");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const from = await beginGesture(page);
  await page.mouse.down();
  await page.mouse.up();
  await expect(dialog).toHaveCount(0);
  const result = await endGesture(page, from);
  const step = (await lastHistoryItem(page).textContent()) ?? "";
  setup.historyStep = step;
  if (step !== "Gaussian Blur")
    notes.push(`the effect was not recorded (last history item: ${step})`);
  return result;
}

scenario("B12a", "Gaussian Blur OK after its preview, default image", (page, setup, notes) =>
  effectCommit(page, setup, notes, false),
);

scenario("B12b", "Gaussian Blur OK after its preview, 4000 x 3000", (page, setup, notes) =>
  effectCommit(page, setup, notes, true),
);

/**
 * B13: Gradient with no selection. The drag starts at the image's center and its end circles fast
 * for 3 s, so the whole layer's gradient changes on every frame.
 */
async function gradientDrag(page: Page, setup: Setup, notes: string[], large: boolean) {
  const { layout, devicePixelRatio, box } = await openImage(page, setup, large);
  await page.getByRole("radio", { name: "Gradient", exact: true }).click();
  const image = visibleImage(box, layout, devicePixelRatio);
  const center = { x: image.x + image.width / 2, y: image.y + image.height / 2 };
  const radius = Math.min(image.width, image.height) * 0.3;
  const moves = [
    ...linePath(center, { x: center.x + radius, y: center.y }, 12),
    ...circlePath(center, radius, CIRCLE_TURNS, CIRCLE_MOVES).slice(1),
  ];
  Object.assign(setup, { moves: moves.length, turns: CIRCLE_TURNS, inputHz: INPUT_HZ });
  await page.mouse.move(center.x, center.y);
  const from = await beginGesture(page);
  await page.mouse.down();
  setup.sendMs = Math.round(await paceMoves(page, moves, INPUT_HZ));
  await page.mouse.up();
  const result = await endGesture(page, from);
  const step = (await lastHistoryItem(page).textContent()) ?? "";
  setup.historyStep = step;
  if (step !== "Gradient") notes.push(`the gradient was not recorded (last history item: ${step})`);
  return result;
}

scenario(
  "B13a",
  "Gradient end dragged in fast circles, no selection, default image",
  (page, setup, notes) => gradientDrag(page, setup, notes, false),
);

scenario(
  "B13b",
  "Gradient end dragged in fast circles, no selection, 4000 x 3000",
  (page, setup, notes) => gradientDrag(page, setup, notes, true),
);

/** Opens an adjustment's dialog from the Adjustments menu and waits for its first preview. */
async function openAdjustment(page: Page, setup: Setup, name: RegExp) {
  setup.layers = 1;
  setup.openSettled = (await createDocument(page, 1)).idle;
  await fitToWindow(page);
  await page.getByRole("button", { name: "Adjustments", exact: true }).click();
  await page.getByRole("menuitem", { name }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  setup.firstPreviewSettled = (await idle(page, SETUP_CAP_MS)).idle;
  return dialog;
}

/**
 * B15: Curves on 4000 x 3000. A point is added in the middle of the curve editor and dragged in
 * circles for 2 s, so the luminosity curve and the preview change on every move.
 */
scenario("B15", "Curves point dragged for 2 s, 4000 x 3000", async (page, setup) => {
  const dialog = await openAdjustment(page, setup, /^Curves/);
  const plot = await dialog.getByRole("img", { name: "Curve editor" }).boundingBox();
  if (plot === null) throw new Error("The curve editor has no box.");
  const center = { x: plot.x + plot.width * 0.5, y: plot.y + plot.height * 0.5 };
  const radius = Math.min(plot.width, plot.height) * 0.25;
  const moves = [
    ...linePath(center, { x: center.x + radius, y: center.y }, 8),
    ...circlePath(center, radius, 4, DRAG_MOVES - 8).slice(1),
  ];
  Object.assign(setup, { moves: moves.length, inputHz: INPUT_HZ });
  await page.mouse.move(center.x, center.y);
  const from = await beginGesture(page);
  await page.mouse.down();
  setup.sendMs = Math.round(await paceMoves(page, moves, INPUT_HZ));
  await page.mouse.up();
  const result = await endGesture(page, from);
  await page.keyboard.press("Escape");
  return result;
});

/** B16: Hue / Saturation on 4000 x 3000, its Saturation slider dragged for 2 s. */
scenario(
  "B16",
  "Hue / Saturation live preview, Saturation slider dragged for 2 s, 4000 x 3000",
  async (page, setup) => {
    const dialog = await openAdjustment(page, setup, /^Hue \/ Saturation/);
    const thumb = dialog.getByRole("slider", { name: "Saturation", exact: true });
    const track = await thumb.locator("..").boundingBox();
    if (track === null) throw new Error("The Saturation slider has no track.");
    const [first, ...moves] = sliderPath(track, 0.5, 0.05, DRAG_MOVES);
    Object.assign(setup, { sliderFrom: 0.5, sliderTo: 0.05, moves: DRAG_MOVES, inputHz: INPUT_HZ });
    if (first === undefined) throw new Error("The drag has no points.");
    await page.mouse.move(first.x, first.y);
    const from = await beginGesture(page);
    await page.mouse.down();
    setup.sendMs = Math.round(await paceMoves(page, moves, INPUT_HZ));
    await page.mouse.up();
    const result = await endGesture(page, from);
    setup.saturationAfter = Number(await thumb.getAttribute("aria-valuenow"));
    await page.keyboard.press("Escape");
    return result;
  },
);

/** B14: Image › Resize of the default image to 3000 px wide, committed with OK. */
scenario("B14", "Resize the default image to 3000 px wide", async (page, setup, notes) => {
  await fitToWindow(page);
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Resize/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.getByLabel("Width", { exact: true }).first().fill("3000");
  await page.getByLabel("Width", { exact: true }).first().press("Tab");
  const ok = dialog.getByRole("button", { name: "OK", exact: true });
  const box = await ok.boundingBox();
  if (box === null) throw new Error("The OK button has no box.");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  setup.width = 3000;
  const from = await beginGesture(page);
  await page.mouse.down();
  await page.mouse.up();
  await expect(dialog).toHaveCount(0);
  await expect(lastHistoryItem(page)).toHaveText("Resize");
  const result = await endGesture(page, from);
  const step = (await lastHistoryItem(page).textContent()) ?? "";
  setup.historyStep = step;
  if (step !== "Resize") notes.push(`the resize was not recorded (last history item: ${step})`);
  return result;
});

/** Starts recording animation frames and the slider's shown values in the page. */
async function startSliderWatch(page: Page, selector: string): Promise<void> {
  await page.evaluate((query) => {
    const slider = document.querySelector(query);
    const watch = { frames: [] as number[], updates: [] as number[], running: true };
    (window as unknown as { __sliderWatch: typeof watch }).__sliderWatch = watch;
    const frame = (time: number) => {
      if (!watch.running) return;
      watch.frames.push(time);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    if (slider !== null) {
      new MutationObserver(() => watch.updates.push(performance.now())).observe(slider, {
        attributes: true,
        attributeFilter: ["aria-valuenow"],
      });
    }
  }, selector);
}

/** Stops the watch and describes the frame rate and the slider's visible updates. */
async function stopSliderWatch(page: Page, gestureMs: number): Promise<string> {
  const { frames, updates } = await page.evaluate(() => {
    const watch = (
      window as unknown as {
        __sliderWatch: { frames: number[]; updates: number[]; running: boolean };
      }
    ).__sliderWatch;
    watch.running = false;
    return { frames: watch.frames, updates: watch.updates };
  });
  const intervals = frames.slice(1).map((time, index) => time - (frames[index] ?? time));
  intervals.sort((a, b) => a - b);
  const at = (q: number) =>
    intervals[Math.min(intervals.length - 1, Math.floor(q * intervals.length))] ?? 0;
  const seconds = gestureMs / 1000;
  return `frames ${(frames.length / seconds).toFixed(0)}/s, frame interval p50/p95/max ${at(0.5).toFixed(1)}/${at(0.95).toFixed(1)}/${(intervals.at(-1) ?? 0).toFixed(1)} ms, slider updates ${(updates.length / seconds).toFixed(0)}/s`;
}

/**
 * B18: the Paintbrush's Hardness slider in the tool options bar, dragged back and forth quickly for
 * 2 s (8 sweeps across its whole range and a little past both ends).
 */
scenario(
  "B18",
  "Hardness slider in the options bar dragged back and forth for 2 s, default image",
  async (page, setup, notes) => {
    await fitToWindow(page);
    await page.getByRole("radio", { name: "Paintbrush", exact: true }).click();
    const selector = '.app-tool-config [role="slider"][aria-label="Hardness"]';
    const slider = page.locator(selector);
    const track = await slider.boundingBox();
    if (track === null) throw new Error("The Hardness slider has no box.");
    const [first, ...moves] = sliderSweepPath(track, -0.2, 1.2, 8, DRAG_MOVES);
    Object.assign(setup, { sweeps: 8, moves: DRAG_MOVES, inputHz: INPUT_HZ });
    if (first === undefined) throw new Error("The drag has no points.");
    await page.mouse.move(first.x, first.y);
    await startSliderWatch(page, selector);
    const from = await beginGesture(page);
    await page.mouse.down();
    const sendMs = await paceMoves(page, moves, INPUT_HZ);
    setup.sendMs = Math.round(sendMs);
    await page.mouse.up();
    const result = await endGesture(page, from);
    notes.push(await stopSliderWatch(page, sendMs));
    return result;
  },
);

/** B19: the Pencil (default width) scribbled fast over the visible image for 2 s. */
async function pencilScribble(page: Page, setup: Setup, notes: string[], large: boolean) {
  const { layout, devicePixelRatio, box } = await openImage(page, setup, large);
  await page.getByRole("radio", { name: "Pencil", exact: true }).click();
  const [first, ...moves] = scribblePath(visibleImage(box, layout, devicePixelRatio), DRAG_MOVES);
  Object.assign(setup, { moves: DRAG_MOVES, inputHz: INPUT_HZ });
  if (first === undefined) throw new Error("The scribble has no points.");
  await page.mouse.move(first.x, first.y);
  const from = await beginGesture(page);
  await page.mouse.down();
  setup.sendMs = Math.round(await paceMoves(page, moves, INPUT_HZ));
  await page.mouse.up();
  const result = await endGesture(page, from);
  const step = (await lastHistoryItem(page).textContent()) ?? "";
  setup.historyStep = step;
  if (step !== "Pencil") notes.push(`the stroke was not recorded (last history item: ${step})`);
  return result;
}

scenario("B19a", "Pencil scribbled fast for 2 s, default image", (page, setup, notes) =>
  pencilScribble(page, setup, notes, false),
);

scenario("B19b", "Pencil scribbled fast for 2 s, 4000 x 3000", (page, setup, notes) =>
  pencilScribble(page, setup, notes, true),
);

/**
 * B20: a pending rectangle outline over the middle 40 % of the image, dragged by its body in fast
 * circles for 2 s, so the whole shape moves on every frame (TL-SHAPE-01).
 */
/** A quarter turn more than whole circles, so the shape ends moved and the move is recorded. */
const BODY_TURNS = 4.25;

async function shapeBodyDrag(page: Page, setup: Setup, notes: string[], large: boolean) {
  const { layout, devicePixelRatio, box } = await openImage(page, setup, large);
  await page.getByRole("radio", { name: "Shapes", exact: true }).click();
  const image = visibleImage(box, layout, devicePixelRatio);
  const a = { x: image.x + image.width * 0.3, y: image.y + image.height * 0.3 };
  const b = { x: image.x + image.width * 0.7, y: image.y + image.height * 0.7 };
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await paceMoves(page, linePath(a, b, 20), INPUT_HZ);
  await page.mouse.up();
  await idle(page, SETUP_CAP_MS);
  // Inside the frame, a quarter of the way in from its top-left corner: the body.
  const press = { x: a.x + (b.x - a.x) * 0.25, y: a.y + (b.y - a.y) * 0.25 };
  const radius = Math.min(image.width, image.height) * 0.15;
  const circles = circlePath(
    { x: press.x - radius, y: press.y },
    radius,
    BODY_TURNS,
    DRAG_MOVES,
  ).slice(1);
  Object.assign(setup, { moves: circles.length, turns: BODY_TURNS, inputHz: INPUT_HZ });
  await page.mouse.move(press.x, press.y);
  const from = await beginGesture(page);
  await page.mouse.down();
  setup.sendMs = Math.round(await paceMoves(page, circles, INPUT_HZ));
  await page.mouse.up();
  const result = await endGesture(page, from);
  const step = (await lastHistoryItem(page).textContent()) ?? "";
  setup.historyStep = step;
  if (!step.startsWith("Adjust"))
    notes.push(`the move was not recorded (last history item: ${step})`);
  return result;
}

scenario("B20a", "Pending shape dragged by its body in fast circles, default image", (p, s, n) =>
  shapeBodyDrag(p, s, n, false),
);

scenario("B20b", "Pending shape dragged by its body in fast circles, 4000 x 3000", (p, s, n) =>
  shapeBodyDrag(p, s, n, true),
);

/**
 * B21: Rectangle Select drawn from the image's top-left quarter, its far corner circling fast for
 * 2 s on 4000 x 3000, so the selection outline changes on every frame.
 */
scenario(
  "B21",
  "Rectangle Select corner dragged in fast circles, 4000 x 3000",
  async (page, setup, notes) => {
    const { layout, devicePixelRatio, box } = await openImage(page, setup, true);
    await page.getByRole("radio", { name: "Rectangle Select", exact: true }).click();
    const image = visibleImage(box, layout, devicePixelRatio);
    const start = { x: image.x + image.width * 0.2, y: image.y + image.height * 0.2 };
    const center = { x: image.x + image.width * 0.6, y: image.y + image.height * 0.6 };
    const radius = Math.min(image.width, image.height) * 0.2;
    const moves = [
      ...linePath(start, { x: center.x + radius, y: center.y }, 12),
      ...circlePath(center, radius, CIRCLE_TURNS - 2, DRAG_MOVES).slice(1),
    ];
    Object.assign(setup, { moves: moves.length, inputHz: INPUT_HZ });
    await page.mouse.move(start.x, start.y);
    const from = await beginGesture(page);
    await page.mouse.down();
    setup.sendMs = Math.round(await paceMoves(page, moves, INPUT_HZ));
    await page.mouse.up();
    const result = await endGesture(page, from);
    const step = (await lastHistoryItem(page).textContent()) ?? "";
    setup.historyStep = step;
    if (step !== "Rectangle Select")
      notes.push(`the selection was not recorded (last history item: ${step})`);
    return result;
  },
);

/** B22: Move Selection (the outline only) after a rectangle selection, 2 s drag on 4000 x 3000. */
scenario(
  "B22",
  "Move Selection outline, 2 s drag at fit-to-window, 4000 x 3000",
  async (page, setup, notes) => {
    const { layout, devicePixelRatio, box } = await openImage(page, setup, true);
    await page.getByRole("radio", { name: "Rectangle Select", exact: true }).click();
    const image = visibleImage(box, layout, devicePixelRatio);
    const a = { x: image.x + image.width * 0.25, y: image.y + image.height * 0.25 };
    const b = { x: image.x + image.width * 0.6, y: image.y + image.height * 0.6 };
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await paceMoves(page, linePath(a, b, 12), INPUT_HZ);
    await page.mouse.up();
    await idle(page, SETUP_CAP_MS);
    await page.getByRole("radio", { name: "Move Selection", exact: true }).click();
    const press = { x: a.x + (b.x - a.x) * 0.3, y: a.y + (b.y - a.y) * 0.3 };
    const [first, ...moves] = dragPath(press, MOVE_DRAG_CSS, DRAG_MOVES);
    Object.assign(setup, { moves: DRAG_MOVES, inputHz: INPUT_HZ });
    if (first === undefined) throw new Error("The drag has no points.");
    await page.mouse.move(first.x, first.y);
    const from = await beginGesture(page);
    await page.mouse.down();
    setup.sendMs = Math.round(await paceMoves(page, moves, INPUT_HZ));
    await page.mouse.up();
    const result = await endGesture(page, from);
    const step = (await lastHistoryItem(page).textContent()) ?? "";
    setup.historyStep = step;
    if (step !== "Move Selection")
      notes.push(`the move was not recorded (last history item: ${step})`);
    return result;
  },
);
