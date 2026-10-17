/**
 * How far the pointer may move from where it was pressed, in CSS pixels, while the press still
 * counts as a click (TL-SEL-01). It is measured on screen, so it does not depend on the zoom: a
 * user who wants a tiny drag zooms in.
 */
export const CLICK_DEAD_ZONE_CSS_PX = 4;

/** A pointer sample as the dead zone reads it. A `ToolPointerEvent` satisfies this. */
export interface DeadZoneSample {
  /** The position in canvas pixels. */
  readonly x: number;
  readonly y: number;
  /** The position in CSS pixels, in client coordinates. */
  readonly clientX?: number;
  readonly clientY?: number;
}

/**
 * Tells a click from a drag. The press is a click until the pointer moves more than `radius` CSS
 * pixels from the press point, and from then on it is a drag, even if the pointer comes back. A
 * drag still starts at the press point, not where it left the zone. Samples without client
 * coordinates are measured in canvas pixels, as at 100 % zoom.
 */
export class ClickDeadZone {
  readonly press: DeadZoneSample;
  readonly #radius: number;
  #left = false;

  constructor(press: DeadZoneSample, radius: number = CLICK_DEAD_ZONE_CSS_PX) {
    this.press = press;
    this.#radius = radius;
  }

  /** Whether the pointer has left the zone, so the press is a drag. */
  get left(): boolean {
    return this.#left;
  }

  /** Checks a later sample of the same press. Returns whether the pointer has left the zone. */
  track(sample: DeadZoneSample): boolean {
    if (!this.#left) this.#left = screenDistance(this.press, sample) > this.#radius;
    return this.#left;
  }
}

/** The distance between two samples in CSS pixels, or in canvas pixels without client coordinates. */
export function screenDistance(a: DeadZoneSample, b: DeadZoneSample): number {
  if (
    a.clientX !== undefined &&
    a.clientY !== undefined &&
    b.clientX !== undefined &&
    b.clientY !== undefined
  ) {
    return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
  }
  return Math.hypot(b.x - a.x, b.y - a.y);
}
