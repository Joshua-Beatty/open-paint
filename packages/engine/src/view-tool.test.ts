import { describe, expect, it } from "vitest";
import {
  applyCommand,
  FIT_VIEW,
  resolveView,
  type ViewState,
  viewLayout,
  viewStatus,
} from "./view";

const viewport = { width: 800, height: 600 };
const doc = { width: 1000, height: 1000 };
const fixedAt = (zoom: number, originX: number, originY: number): ViewState => ({
  mode: "fixed",
  zoom,
  originX,
  originY,
});

describe("zoom step at a point (Zoom tool, TL-ZOOM-01)", () => {
  it("steps to the next preset and keeps the image point under the anchor", () => {
    const start = fixedAt(1, -100, -50);
    const before = resolveView(start, doc, viewport);
    const imageX = 300;
    const imageY = 200;
    const anchorBefore = before.originX + imageX * before.zoom;
    const view = applyCommand(start, doc, viewport, {
      type: "zoomStepAt",
      direction: 1,
      x: imageX,
      y: imageY,
    });
    const after = resolveView(view, doc, viewport);
    expect(after.zoom).toBe(3 / 2);
    expect(after.originX + imageX * after.zoom).toBeCloseTo(anchorBefore);
    expect(after.originY + imageY * after.zoom).toBeCloseTo(before.originY + imageY * before.zoom);
  });

  it("steps out with direction -1", () => {
    const view = applyCommand(fixedAt(1, 0, 0), doc, viewport, {
      type: "zoomStepAt",
      direction: -1,
      x: 10,
      y: 10,
    });
    expect(viewStatus(view, doc, viewport)).toEqual({ mode: "fixed", zoom: 2 / 3 });
  });

  it("does not step a zoom-in past the cap, and leaves the view when no step is left", () => {
    const capped = applyCommand(fixedAt(1, 0, 0), doc, viewport, {
      type: "zoomStepAt",
      direction: 1,
      x: 0,
      y: 0,
      maxZoom: 1,
    });
    expect(viewStatus(capped, doc, viewport)).toEqual({ mode: "fixed", zoom: 1 });
    const atCap = fixedAt(64, 0, 0);
    expect(
      applyCommand(atCap, doc, viewport, {
        type: "zoomStepAt",
        direction: 1,
        x: 0,
        y: 0,
        maxZoom: 64,
      }),
    ).toEqual(atCap);
  });

  it("starts from the fit zoom", () => {
    const view = applyCommand(FIT_VIEW, doc, viewport, {
      type: "zoomStepAt",
      direction: -1,
      x: 500,
      y: 500,
    });
    expect(viewStatus(view, doc, viewport)).toEqual({ mode: "fixed", zoom: 0.5 });
  });
});

describe("zoom to rectangle cap (Zoom tool, TL-ZOOM-01)", () => {
  it("stops at the cap rather than the view's own maximum", () => {
    const view = applyCommand(FIT_VIEW, doc, viewport, {
      type: "zoomToRect",
      x: 100,
      y: 100,
      width: 0.5,
      height: 0.5,
      maxZoom: 64,
    });
    const layout = viewLayout(view, doc, viewport);
    expect(layout.zoom).toBe(64);
  });

  it("keeps the view's maximum when no cap is given", () => {
    const view = applyCommand(FIT_VIEW, doc, viewport, {
      type: "zoomToRect",
      x: 100,
      y: 100,
      width: 0.5,
      height: 0.5,
    });
    expect(viewStatus(view, doc, viewport).zoom).toBe(100);
  });
});
