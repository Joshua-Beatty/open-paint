import type { ViewCommand } from "@openpaint/engine";

/** Two touch points in device pixels, relative to the canvas (WEB-PTR-03). */
export interface TouchPoint {
  readonly x: number;
  readonly y: number;
}

/** The midpoint and the distance between two touch points. */
export interface TouchSpan {
  readonly x: number;
  readonly y: number;
  readonly distance: number;
}

export function touchSpan(first: TouchPoint, second: TouchPoint): TouchSpan {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
    distance: Math.hypot(first.x - second.x, first.y - second.y),
  };
}

/**
 * The view step for a pinch that moved from `from` to `to`: zoom by the change in distance around
 * the old midpoint, then pan by the midpoint's travel. Undefined when either span is empty, since
 * no zoom ratio exists.
 */
export function pinchCommand(from: TouchSpan, to: TouchSpan): ViewCommand | undefined {
  if (!(from.distance > 0) || !(to.distance > 0)) return undefined;
  return {
    type: "pinch",
    ratio: to.distance / from.distance,
    x: from.x,
    y: from.y,
    dx: to.x - from.x,
    dy: to.y - from.y,
  };
}
