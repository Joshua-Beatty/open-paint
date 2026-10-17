import { describe, expect, it } from "vitest";
import { CLICK_DEAD_ZONE_CSS_PX, ClickDeadZone, screenDistance } from "./dead-zone";

/** A sample at a client point, with its canvas point at `zoom` CSS pixels per canvas pixel. */
function at(clientX: number, clientY: number, zoom: number) {
  return { clientX, clientY, x: clientX / zoom, y: clientY / zoom };
}

describe("ClickDeadZone", () => {
  it("is 4 CSS pixels", () => {
    expect(CLICK_DEAD_ZONE_CSS_PX).toBe(4);
  });

  for (const zoom of [0.25, 1, 8]) {
    it(`measures on screen at ${zoom * 100} % zoom`, () => {
      const jitter = new ClickDeadZone(at(100, 100, zoom));
      expect(jitter.track(at(103, 100, zoom))).toBe(false);
      expect(jitter.track(at(102, 102, zoom))).toBe(false);
      expect(jitter.left).toBe(false);

      const drag = new ClickDeadZone(at(100, 100, zoom));
      expect(drag.track(at(106, 100, zoom))).toBe(true);
    });
  }

  it("stays a drag once the pointer has left, even back at the press", () => {
    const zone = new ClickDeadZone(at(10, 10, 1));
    zone.track(at(20, 10, 1));
    expect(zone.track(at(10, 10, 1))).toBe(true);
    expect(zone.press).toMatchObject({ x: 10, y: 10 });
  });

  it("measures canvas pixels when a sample has no client coordinates", () => {
    expect(screenDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(screenDistance({ x: 0, y: 0, clientX: 0, clientY: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});
