import { rect, rectPolygon, Selection } from "@openpaint/document";
import { describe, expect, it, vi } from "vitest";
import {
  BRUSH_POINTER_CURSOR,
  CLONE_ANCHOR_CURSOR,
  HANDLE_HIT_CSS_PX,
  handleHitRadius,
  nearHandle,
  PICK_IMAGE_CURSOR,
  PICK_LAYER_CURSOR,
  resizeCursor,
  rotateCursor,
  selectionBounds,
  TEXT_PLACE_CURSOR,
  viewScaleOf,
} from "./cursors";

describe("handle hit areas (TL-FRAME-06)", () => {
  it("measure the radius in CSS pixels, at 100 % for samples without a zoom", () => {
    expect(viewScaleOf(undefined)).toBe(1);
    expect(viewScaleOf({ viewScale: 0 })).toBe(1);
    expect(handleHitRadius({})).toBe(HANDLE_HIT_CSS_PX);
    expect(handleHitRadius({ viewScale: 4 })).toBe(HANDLE_HIT_CSS_PX / 4);
    expect(handleHitRadius({ viewScale: 0.5 })).toBe(HANDLE_HIT_CSS_PX * 2);
  });

  it("are larger than the click dead zone, so a click that stays in it stays on the handle", () => {
    expect(HANDLE_HIT_CSS_PX).toBeGreaterThan(4);
  });

  it("find a handle within the radius on screen", () => {
    expect(nearHandle({ x: 10, y: 13, viewScale: 2 }, { x: 10, y: 10 })).toBe(true);
    expect(nearHandle({ x: 10, y: 14, viewScale: 2 }, { x: 10, y: 10 })).toBe(false);
  });
});

describe("cursor glyphs", () => {
  it("are inline SVGs with a hot spot and a CSS fallback", () => {
    for (const cursor of [
      BRUSH_POINTER_CURSOR,
      CLONE_ANCHOR_CURSOR,
      TEXT_PLACE_CURSOR,
      PICK_LAYER_CURSOR,
      PICK_IMAGE_CURSOR,
      rotateCursor(1, 1),
    ]) {
      expect(cursor).toMatch(/^url\("data:image\/svg\+xml,[^"]+"\) \d+ \d+, [a-z-]+$/);
    }
    expect(PICK_IMAGE_CURSOR).not.toBe(PICK_LAYER_CURSOR);
  });

  it("point the resize cursor along the handle's direction", () => {
    expect(resizeCursor(1, 0)).toBe("ew-resize");
    expect(resizeCursor(-1, 0)).toBe("ew-resize");
    expect(resizeCursor(0, 1)).toBe("ns-resize");
    expect(resizeCursor(1, 1)).toBe("nwse-resize");
    expect(resizeCursor(-1, -1)).toBe("nwse-resize");
    expect(resizeCursor(1, -1)).toBe("nesw-resize");
    expect(resizeCursor(-1, 1)).toBe("nesw-resize");
    expect(resizeCursor(1, 0.3)).toBe("ew-resize");
    expect(resizeCursor(1, 0.6)).toBe("nwse-resize");
  });

  it("turn the rotate cursor towards the pointer, and reuse each turned glyph", () => {
    expect(rotateCursor(10, 0)).toBe(rotateCursor(20, 0.1));
    expect(rotateCursor(10, 0)).not.toBe(rotateCursor(0, 10));
    expect(rotateCursor(10, 10)).not.toBe(rotateCursor(-10, -10));
    expect(decodeURIComponent(rotateCursor(0, 10))).toContain("rotate(90 12 12)");
  });
});

describe("selectionBounds", () => {
  it("computes a selection's bounds once", () => {
    const selection = new Selection([rectPolygon(rect(2, 3, 4, 5))]);
    const bounds = vi.spyOn(selection, "bounds");
    expect(selectionBounds(selection)).toEqual(rect(2, 3, 4, 5));
    expect(selectionBounds(selection)).toEqual(rect(2, 3, 4, 5));
    expect(bounds).toHaveBeenCalledTimes(1);
  });
});
