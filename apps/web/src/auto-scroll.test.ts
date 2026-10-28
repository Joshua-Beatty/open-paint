import { describe, expect, it } from "vitest";
import {
  AUTO_SCROLL_BAND_CSS_PIXELS,
  AUTO_SCROLL_DWELL_MS,
  AutoScrollDwell,
  AutoScrollPress,
  autoScrollDelta,
  DEFAULT_AUTO_SCROLL,
} from "./auto-scroll";

const view = { width: 400, height: 300 };
const on = { enabled: true, speed: 2000 };

describe("autoScrollDelta (TL-HOTKEY-03)", () => {
  it("does nothing in the middle of the view", () => {
    expect(autoScrollDelta({ x: 200, y: 150 }, view, on, 1)).toEqual({ dx: 0, dy: 0 });
  });

  it("pans the image toward a start edge (a positive movement) at full speed at the edge", () => {
    expect(autoScrollDelta({ x: 0, y: 150 }, view, on, 0.5)).toEqual({ dx: 1000, dy: 0 });
    expect(autoScrollDelta({ x: 150, y: 0 }, view, on, 0.5)).toEqual({ dx: 0, dy: 1000 });
  });

  it("pans the image toward an end edge (a negative movement) at the far edge", () => {
    expect(autoScrollDelta({ x: 400, y: 150 }, view, on, 0.5)).toEqual({ dx: -1000, dy: 0 });
    expect(autoScrollDelta({ x: 150, y: 300 }, view, on, 0.5)).toEqual({ dx: 0, dy: -1000 });
  });

  it("never scrolls with the pointer past the edge, over the panels or out of the window", () => {
    for (const pointer of [
      { x: -50, y: 150 },
      { x: 150, y: -10 },
      { x: 450, y: 150 },
      { x: 150, y: 400 },
      { x: 401, y: 0 },
      { x: 2000, y: 299 },
    ]) {
      expect(autoScrollDelta(pointer, view, on, 1)).toEqual({ dx: 0, dy: 0 });
    }
  });

  it("ramps up across the band, from zero at its inner edge to full speed at the edge", () => {
    const band = AUTO_SCROLL_BAND_CSS_PIXELS;
    const half = autoScrollDelta({ x: band / 2, y: 150 }, view, on, 1);
    expect(half.dx).toBeCloseTo(1000, 6);
    const inner = autoScrollDelta({ x: band + 1, y: 150 }, view, on, 1);
    expect(inner.dx).toBe(0);
    const near = autoScrollDelta({ x: band - 6, y: 150 }, view, on, 1);
    expect(near.dx).toBeCloseTo((2000 * 6) / band, 6);
  });

  it("scales with the elapsed time and the speed setting", () => {
    expect(autoScrollDelta({ x: 0, y: 150 }, view, { enabled: true, speed: 100 }, 2).dx).toBe(200);
    expect(autoScrollDelta({ x: 0, y: 150 }, view, on, 0)).toEqual({ dx: 0, dy: 0 });
  });

  it("does nothing while the setting is off", () => {
    expect(autoScrollDelta({ x: 0, y: 0 }, view, { enabled: false, speed: 2000 }, 1)).toEqual({
      dx: 0,
      dy: 0,
    });
  });

  it("keeps a tiny viewport from scrolling twice from both edges", () => {
    const tiny = { width: 20, height: 20 };
    expect(autoScrollDelta({ x: 10, y: 10 }, tiny, on, 1)).toEqual({ dx: 0, dy: 0 });
  });

  it("is off by default, so painting never moves the view (owner request)", () => {
    expect(DEFAULT_AUTO_SCROLL).toEqual({ enabled: false, speed: 2000 });
    expect(autoScrollDelta({ x: 0, y: 0 }, view, DEFAULT_AUTO_SCROLL, 1)).toEqual({
      dx: 0,
      dy: 0,
    });
  });
});

describe("AutoScrollDwell", () => {
  it("scrolls only once the pointer has been held at the edge", () => {
    const dwell = new AutoScrollDwell();
    expect(dwell.step(true, 1000)).toBe(false);
    expect(dwell.step(true, 1000 + AUTO_SCROLL_DWELL_MS - 1)).toBe(false);
    expect(dwell.step(true, 1000 + AUTO_SCROLL_DWELL_MS)).toBe(true);
    expect(dwell.step(true, 2000)).toBe(true);
  });

  it("never scrolls for a pointer passing the edge on its way out, and starts over", () => {
    const dwell = new AutoScrollDwell();
    expect(dwell.step(true, 0)).toBe(false);
    expect(dwell.step(true, 16)).toBe(false);
    expect(dwell.step(false, 32)).toBe(false);
    expect(dwell.step(true, AUTO_SCROLL_DWELL_MS + 32)).toBe(false);
    expect(dwell.step(false, 1000)).toBe(false);
  });
});

describe("AutoScrollPress (TL-HOTKEY-03)", () => {
  it("stays a click, which never scrolls, inside the 4 CSS px dead zone", () => {
    const press = new AutoScrollPress({ clientX: 4, clientY: 4 });
    expect(press.armed).toBe(false);
    press.move({ clientX: 6, clientY: 7 });
    expect(press.armed).toBe(false);
  });

  it("scrolls once the press is a drag, even after the pointer comes back", () => {
    const press = new AutoScrollPress({ clientX: 4, clientY: 4 });
    press.move({ clientX: 12, clientY: 4 });
    expect(press.armed).toBe(true);
    press.move({ clientX: 4, clientY: 4 });
    expect(press.armed).toBe(true);
  });
});
