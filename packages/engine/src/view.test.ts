import { describe, expect, it } from "vitest";
import {
  actualSize,
  applyCommand,
  applyWheel,
  canScroll,
  clampZoom,
  FIT_VIEW,
  fitZoom,
  layoutState,
  MAX_ZOOM,
  MIN_ZOOM,
  originRange,
  panBy,
  resolveView,
  type ViewState,
  viewLayout,
  viewStatus,
  WHEEL_ZOOM_FACTOR,
  wheelCssPixels,
  ZOOM_PRESETS,
  zoomAround,
  zoomStep,
} from "./view";

const viewport = { width: 800, height: 600 };
const big = { width: 1000, height: 1000 };
const fixedAt = (zoom: number, originX: number, originY: number): ViewState => ({
  mode: "fixed",
  zoom,
  originX,
  originY,
});

describe("zoom presets (UI-VIEW-01)", () => {
  it("lists the 45 presets from 1 % to 10 000 % in ascending order", () => {
    expect(ZOOM_PRESETS).toHaveLength(45);
    expect(ZOOM_PRESETS[0]).toBe(MIN_ZOOM);
    expect(ZOOM_PRESETS.at(-1)).toBe(MAX_ZOOM);
    expect(ZOOM_PRESETS).toContain(1);
    expect(ZOOM_PRESETS).toEqual([...ZOOM_PRESETS].sort((a, b) => a - b));
  });

  it("clamps zoom to the range", () => {
    expect(clampZoom(0.0001)).toBe(MIN_ZOOM);
    expect(clampZoom(1000)).toBe(MAX_ZOOM);
    expect(clampZoom(2)).toBe(2);
  });

  it("steps to the neighbouring preset and stops at the ends", () => {
    const fixed = fixedAt(1, 0, 0);
    expect(zoomStep(fixed, big, viewport, 1)).toMatchObject({ zoom: 3 / 2 });
    expect(zoomStep(fixed, big, viewport, -1)).toMatchObject({ zoom: 2 / 3 });
    expect(zoomStep(fixedAt(MAX_ZOOM, 0, 0), big, viewport, 1)).toEqual(fixedAt(MAX_ZOOM, 0, 0));
    expect(zoomStep(fixedAt(MIN_ZOOM, 0, 0), big, viewport, -1)).toEqual(fixedAt(MIN_ZOOM, 0, 0));
  });

  it("steps from the fit zoom to the preset around it", () => {
    const doc = { width: 300, height: 200 };
    const fit = resolveView(FIT_VIEW, doc, viewport).zoom;
    expect(fit).toBeCloseTo(800 / 300);
    expect(zoomStep(FIT_VIEW, doc, viewport, 1)).toMatchObject({ mode: "fixed", zoom: 3 });
    expect(zoomStep(FIT_VIEW, doc, viewport, -1)).toMatchObject({ mode: "fixed", zoom: 2 });
  });
});

describe("touch pinch (WEB-PTR-03)", () => {
  it("zooms around the old midpoint and then pans by the midpoint's travel", () => {
    const pinched = applyCommand(fixedAt(1, 0, 0), big, viewport, {
      type: "pinch",
      ratio: 2,
      x: 100,
      y: 100,
      dx: 10,
      dy: -5,
    });
    expect(pinched).toMatchObject({ mode: "fixed", zoom: 2, originX: -90, originY: -105 });
  });

  it("ignores a ratio that is not a positive number", () => {
    const view = fixedAt(1, 0, 0);
    for (const ratio of [0, -2, Number.NaN]) {
      expect(
        applyCommand(view, big, viewport, { type: "pinch", ratio, x: 0, y: 0, dx: 5, dy: 5 }),
      ).toBe(view);
    }
  });
});

describe("fit to window and actual size", () => {
  it("fits the whole document and centers it", () => {
    const doc = { width: 300, height: 200 };
    const zoom = fitZoom(doc, viewport);
    expect(zoom).toBeCloseTo(800 / 300);
    expect(resolveView(FIT_VIEW, doc, viewport)).toEqual({
      zoom,
      originX: 0,
      originY: Math.round((600 - 200 * zoom) / 2),
    });
  });

  it("clamps the fit zoom to the zoom range", () => {
    expect(fitZoom({ width: 8192, height: 8192 }, viewport)).toBeCloseTo(600 / 8192);
    expect(fitZoom({ width: 1, height: 1 }, { width: 100_000, height: 100_000 })).toBe(MAX_ZOOM);
  });

  it("sets an exact zoom with the viewport center fixed (UI-SB-03)", () => {
    const view = applyCommand(FIT_VIEW, big, viewport, { type: "zoom", ratio: 0.25 });
    expect(view.mode).toBe("fixed");
    expect(viewStatus(view, big, viewport)).toEqual({ mode: "fixed", zoom: 0.25 });
    expect(applyCommand(FIT_VIEW, big, viewport, { type: "zoom", ratio: Number.NaN })).toBe(
      FIT_VIEW,
    );
    expect(applyCommand(FIT_VIEW, big, viewport, { type: "zoom", ratio: 0 })).toBe(FIT_VIEW);
    expect(applyCommand(FIT_VIEW, big, viewport, { type: "zoom", ratio: -2 })).toBe(FIT_VIEW);
  });

  it("zooms to a rectangle so it fills the viewport and is centered (UI-VIEW-01)", () => {
    const view = applyCommand(FIT_VIEW, big, viewport, {
      type: "zoomToRect",
      x: 100,
      y: 200,
      width: 200,
      height: 100,
    });
    expect(viewStatus(view, big, viewport)).toEqual({ mode: "fixed", zoom: 4 });
    const layout = viewLayout(view, big, viewport);
    expect(layout.originX + (100 + 100) * 4).toBe(viewport.width / 2);
    expect(layout.originY + (200 + 50) * 4).toBe(viewport.height / 2);
    expect(
      applyCommand(FIT_VIEW, big, viewport, {
        type: "zoomToRect",
        x: 0,
        y: 0,
        width: 0,
        height: 5,
      }),
    ).toBe(FIT_VIEW);
  });

  it("reports the layout of the image in the viewport", () => {
    const view = fixedAt(2, -100, -50);
    expect(viewLayout(view, big, viewport)).toEqual({
      mode: "fixed",
      zoom: 2,
      originX: -100,
      originY: -50,
      documentWidth: 1000,
      documentHeight: 1000,
    });
  });

  it("sets 100 % with the viewport center fixed", () => {
    const view = actualSize(FIT_VIEW, big, viewport);
    expect(view).toEqual({ mode: "fixed", zoom: 1, originX: -100, originY: -200 });
    expect(viewStatus(view, big, viewport)).toEqual({ mode: "fixed", zoom: 1 });
  });

  it("switches back to fit from any view", () => {
    expect(applyCommand(fixedAt(4, -100, -100), big, viewport, { type: "fit" })).toEqual(FIT_VIEW);
  });
});

describe("zoom around a point", () => {
  it("keeps the image point under the anchor fixed", () => {
    const view = zoomAround(fixedAt(1, 0, 0), big, viewport, 2, 400, 300);
    expect(view).toEqual(fixedAt(2, -400, -300));
    // Image point (400, 300) stays under device pixel (400, 300).
    const resolved = resolveView(view, big, viewport);
    expect((400 - resolved.originX) / resolved.zoom).toBe(400);
  });

  it("clamps the origin so that no overscroll appears", () => {
    expect(zoomAround(fixedAt(1, 0, 0), big, viewport, 4, 0, 0)).toEqual(fixedAt(4, 0, 0));
    expect(zoomAround(fixedAt(1, 0, 0), big, viewport, 4, 800, 600)).toEqual(
      fixedAt(4, -3200 + 800, -2400 + 600),
    );
  });
});

describe("overscroll (UI-VIEW-02)", () => {
  // At 200 % the 1000 px image is 2000 device px, larger than the 800 x 600 viewport.
  const over = (zoom: number, originX: number, originY: number): ViewState => ({
    ...fixedAt(zoom, originX, originY),
    overscroll: true,
  });

  it("lets each edge come in as far as the viewport's centre, and no further", () => {
    expect(originRange(2000, 800, true)).toEqual({ lowest: -1600, highest: 400 });
    expect(originRange(2000, 800, false)).toEqual({ lowest: -1200, highest: 0 });
    expect(panBy(over(2, 0, 0), big, viewport, 10_000, 10_000)).toEqual(over(2, 400, 300));
    expect(panBy(over(2, 0, 0), big, viewport, -10_000, -10_000)).toEqual(
      over(2, 400 - 2000, 300 - 2000),
    );
    expect(panBy(over(2, 0, 0), big, viewport, 150, 100)).toEqual(over(2, 150, 100));
  });

  it("applies the same limit to the wheel, the keys, pinches and zooming around the pointer", () => {
    const wheel = applyWheel(over(2, 300, 0), big, viewport, 1, {
      x: 0,
      y: 0,
      deltaX: 0,
      deltaY: -200,
      deltaMode: 0,
      ctrlKey: false,
      shiftKey: true,
    });
    expect(wheel).toEqual(over(2, 400, 0));
    expect(applyCommand(over(2, 0, 0), big, viewport, { type: "page", direction: "up" })).toEqual(
      over(2, 0, 300),
    );
    expect(applyCommand(over(2, 0, 0), big, viewport, { type: "pan", dx: 900, dy: 0 })).toEqual(
      over(2, 400, 0),
    );
    // Zooming in on the top-left corner keeps it under the pointer at the viewport's centre.
    expect(zoomAround(over(2, 400, 300), big, viewport, 4, 400, 300)).toEqual(over(4, 400, 300));
    const pinched = applyCommand(over(2, 0, 0), big, viewport, {
      type: "pinch",
      ratio: 1,
      x: 0,
      y: 0,
      dx: 5000,
      dy: 0,
    });
    expect(pinched).toEqual(over(2, 400, 0));
  });

  it("lets a small image scroll by the same rule, until an edge reaches the viewport's centre", () => {
    // A 100 px image at 100 % in the 800 x 600 viewport: its left edge may go from 300 to 400.
    const small = { width: 100, height: 100 };
    expect(originRange(100, 800, true)).toEqual({ lowest: 300, highest: 400 });
    expect(panBy(over(1, 350, 250), small, viewport, 30, -20)).toEqual(over(1, 380, 230));
    expect(panBy(over(1, 350, 250), small, viewport, 10_000, 10_000)).toEqual(over(1, 400, 300));
    expect(panBy(over(1, 350, 250), small, viewport, -10_000, -10_000)).toEqual(over(1, 300, 200));
    expect(
      applyCommand(over(1, 350, 250), small, viewport, { type: "page", direction: "down" }),
    ).toEqual(over(1, 350, 200));
    const wheel = applyWheel(over(1, 350, 250), small, viewport, 1, {
      x: 0,
      y: 0,
      deltaX: 0,
      deltaY: 40,
      deltaMode: 0,
      ctrlKey: false,
      shiftKey: false,
    });
    expect(wheel).toEqual(over(1, 350, 210));
    // Without overscroll it stays centred.
    expect(panBy(fixedAt(1, 350, 250), small, viewport, 30, 30)).toEqual(fixedAt(1, 350, 250));
  });

  it("switches a fit view to fixed mode at the same zoom when a scroll moves the image", () => {
    const small = { width: 300, height: 200 };
    const fit = { mode: "fit", overscroll: true } as const;
    // The fit zoom of 300 x 200 in 800 x 600 is 8/3: 800 x 533 device px, centred at (0, 33).
    const zoom = fitZoom(small, viewport);
    expect(resolveView(fit, small, viewport)).toEqual({ zoom, originX: 0, originY: 33 });
    const panned = panBy(fit, small, viewport, 50, -20);
    expect(panned).toEqual({ mode: "fixed", zoom, originX: 50, originY: 13, overscroll: true });
    const dragged = applyCommand(fit, small, viewport, { type: "pan", dx: -10_000, dy: 0 });
    expect(dragged).toMatchObject({ mode: "fixed", zoom, originX: 400 - 800 });
    // A scroll that cannot move the image keeps fit mode.
    expect(panBy(fit, small, viewport, 0, 0)).toBe(fit);
  });

  it("keeps the zoom anchor rules for a scrolled small image", () => {
    const small = { width: 100, height: 100 };
    // The image's top-left at the viewport centre stays under the pointer there.
    expect(zoomAround(over(1, 400, 300), small, viewport, 2, 400, 300)).toEqual(over(2, 400, 300));
    // Zooming out at the centre of a centred image keeps it centred.
    expect(zoomAround(over(2, 300, 200), small, viewport, 1, 400, 300)).toEqual(over(1, 350, 250));
  });

  it("can always scroll, and a layout carries the setting back to its state", () => {
    const small = { width: 100, height: 100 };
    expect(canScroll({ mode: "fit", overscroll: true }, small, viewport)).toBe(true);
    expect(canScroll(FIT_VIEW, big, viewport)).toBe(false);
    expect(canScroll(fixedAt(1, 0, 0), small, viewport)).toBe(false);
    expect(canScroll(fixedAt(2, 0, 0), big, viewport)).toBe(true);
    const view = over(1, 380, 230);
    expect(layoutState(viewLayout(view, small, viewport))).toEqual(view);
    expect(layoutState(viewLayout(FIT_VIEW, small, viewport))).toEqual(FIT_VIEW);
  });

  it("is turned on and off by a command, which pulls the image back inside when it turns off", () => {
    const on = applyCommand(fixedAt(2, 0, 0), big, viewport, { type: "overscroll", enabled: true });
    expect(on).toEqual(over(2, 0, 0));
    const past = panBy(on, big, viewport, 300, 0);
    expect(past).toEqual(over(2, 300, 0));
    expect(applyCommand(past, big, viewport, { type: "overscroll", enabled: false })).toEqual({
      ...fixedAt(2, 0, 0),
      overscroll: false,
    });
    expect(applyCommand(FIT_VIEW, big, viewport, { type: "overscroll", enabled: true })).toEqual({
      mode: "fit",
      overscroll: true,
    });
  });

  it("survives switching to fit and back", () => {
    const fit = applyCommand(over(2, 300, 0), big, viewport, { type: "fit" });
    expect(fit).toEqual({ mode: "fit", overscroll: true });
    expect(applyCommand(fit, big, viewport, { type: "zoom", ratio: 2 })).toMatchObject({
      overscroll: true,
    });
  });
});

describe("pan", () => {
  it("scrolls by device pixels within the image bounds", () => {
    const view = fixedAt(2, 0, 0);
    expect(panBy(view, big, viewport, -100, -50)).toEqual(fixedAt(2, -100, -50));
    expect(panBy(view, big, viewport, 500, 500)).toEqual(fixedAt(2, 0, 0));
    expect(panBy(view, big, viewport, -10_000, 0)).toEqual(fixedAt(2, -1200, 0));
  });

  it("does nothing in fit mode, where the whole image is visible", () => {
    expect(panBy(FIT_VIEW, big, viewport, 100, 100)).toBe(FIT_VIEW);
  });
});

describe("wheel input (WEB-PTR-05)", () => {
  it("counts a notch as 100 CSS pixels and a line as a third of a notch", () => {
    expect(wheelCssPixels(100, 0, 600)).toBe(100);
    expect(wheelCssPixels(3, 1, 600)).toBeCloseTo(100);
    expect(wheelCssPixels(1, 2, 600)).toBe(600);
  });

  it("zooms by 1.12 per notch around the pointer when Ctrl is held", () => {
    const view = applyWheel(FIT_VIEW, big, viewport, 1, {
      x: 400,
      y: 300,
      deltaX: 0,
      deltaY: -100,
      deltaMode: 0,
      ctrlKey: true,
      shiftKey: false,
    });
    expect(viewStatus(view, big, viewport).zoom).toBeCloseTo(WHEEL_ZOOM_FACTOR * (600 / 1000));
    expect(view.mode).toBe("fixed");
  });

  it("zooms out by the same factor and allows fractional notches", () => {
    const start = fixedAt(1, 0, 0);
    const out = applyWheel(start, big, viewport, 1, {
      x: 0,
      y: 0,
      deltaX: 0,
      deltaY: 100,
      deltaMode: 0,
      ctrlKey: true,
      shiftKey: false,
    });
    expect(viewStatus(out, big, viewport).zoom).toBeCloseTo(1 / WHEEL_ZOOM_FACTOR);
    const half = applyWheel(start, big, viewport, 1, {
      x: 0,
      y: 0,
      deltaX: 0,
      deltaY: -50,
      deltaMode: 0,
      ctrlKey: true,
      shiftKey: false,
    });
    expect(viewStatus(half, big, viewport).zoom).toBeCloseTo(WHEEL_ZOOM_FACTOR ** 0.5);
  });

  it("scrolls vertically without Ctrl, in device pixels", () => {
    const view = applyWheel(fixedAt(2, 0, 0), big, viewport, 2, {
      x: 0,
      y: 0,
      deltaX: 0,
      deltaY: 100,
      deltaMode: 0,
      ctrlKey: false,
      shiftKey: false,
    });
    expect(view).toEqual(fixedAt(2, 0, -200));
  });

  it("scrolls horizontally with Shift or a horizontal wheel", () => {
    const start = fixedAt(2, -400, -400);
    const shifted = applyWheel(start, big, viewport, 1, {
      x: 0,
      y: 0,
      deltaX: 0,
      deltaY: 100,
      deltaMode: 0,
      ctrlKey: false,
      shiftKey: true,
    });
    expect(shifted).toEqual(fixedAt(2, -500, -400));
    const tilted = applyWheel(start, big, viewport, 1, {
      x: 0,
      y: 0,
      deltaX: -60,
      deltaY: 0,
      deltaMode: 0,
      ctrlKey: false,
      shiftKey: false,
    });
    expect(tilted).toEqual(fixedAt(2, -340, -400));
  });

  it("leaves fit mode alone when plain wheel input cannot scroll", () => {
    const small = { width: 300, height: 200 };
    expect(
      applyWheel(FIT_VIEW, small, viewport, 1, {
        x: 0,
        y: 0,
        deltaX: 0,
        deltaY: 100,
        deltaMode: 0,
        ctrlKey: false,
        shiftKey: false,
      }),
    ).toBe(FIT_VIEW);
  });
});

describe("applyCommand", () => {
  it("pans with a pan command", () => {
    expect(applyCommand(fixedAt(2, 0, 0), big, viewport, { type: "pan", dx: -30, dy: 0 })).toEqual(
      fixedAt(2, -30, 0),
    );
  });

  it("uses the same pan path for zoom-out to the minimum", () => {
    expect(applyCommand(fixedAt(MIN_ZOOM, 0, 0), big, viewport, { type: "zoomOut" })).toEqual(
      fixedAt(MIN_ZOOM, 0, 0),
    );
  });

  it("scrolls one viewport height per Page Up or Page Down, within the image (UI-KEY-02)", () => {
    // At 200 % the 1000 px image spans -1200 to 0 horizontally and -1400 to 0 vertically.
    const start = fixedAt(2, -600, -700);
    expect(applyCommand(start, big, viewport, { type: "page", direction: "up" })).toEqual(
      fixedAt(2, -600, -100),
    );
    expect(applyCommand(start, big, viewport, { type: "page", direction: "down" })).toEqual(
      fixedAt(2, -600, -1300),
    );
    expect(
      applyCommand(fixedAt(2, -600, -100), big, viewport, { type: "page", direction: "up" }),
    ).toEqual(fixedAt(2, -600, 0));
  });

  it("scrolls one viewport width per Shift+Page Up or Shift+Page Down (UI-KEY-02)", () => {
    const start = fixedAt(2, -600, -700);
    expect(applyCommand(start, big, viewport, { type: "page", direction: "left" })).toEqual(
      fixedAt(2, 0, -700),
    );
    expect(applyCommand(start, big, viewport, { type: "page", direction: "right" })).toEqual(
      fixedAt(2, -1200, -700),
    );
    expect(
      applyCommand(fixedAt(2, -400, -700), big, viewport, { type: "page", direction: "right" }),
    ).toEqual(fixedAt(2, -1200, -700));
  });

  it("jumps to the image's top-left and bottom-right edges (UI-KEY-02)", () => {
    // A 1000 px image at 200 % is 2000 device px, so the viewport (800 x 600) can scroll.
    expect(
      applyCommand(fixedAt(2, -500, -500), big, viewport, { type: "edge", edge: "start" }),
    ).toEqual(fixedAt(2, 0, 0));
    expect(
      applyCommand(fixedAt(2, -500, -500), big, viewport, { type: "edge", edge: "end" }),
    ).toEqual(fixedAt(2, -1200, -1400));
  });

  it("does not scroll in fit mode, and the edge jump centers a small image", () => {
    expect(applyCommand(FIT_VIEW, big, viewport, { type: "page", direction: "up" })).toBe(FIT_VIEW);
    expect(applyCommand(FIT_VIEW, big, viewport, { type: "edge", edge: "end" })).toBe(FIT_VIEW);
    const small = { width: 100, height: 100 };
    const view = applyCommand(fixedAt(1, 0, 0), small, viewport, { type: "edge", edge: "end" });
    expect(resolveView(view, small, viewport)).toEqual({ zoom: 1, originX: 350, originY: 250 });
  });
});
