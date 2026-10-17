/** The visible part of the tab strip, in CSS pixels. */
export interface Viewport {
  readonly scrollLeft: number;
  readonly clientWidth: number;
}

/** The scroll position and sizes of the tab strip, in CSS pixels. */
export interface ScrollMetrics extends Viewport {
  readonly scrollWidth: number;
}

/** A tab's horizontal extent. Coordinates are in one frame, either the strip's or the viewport's. */
export interface Span {
  readonly left: number;
  readonly width: number;
}

export interface OverflowEdges {
  /** The tabs do not all fit, so the scroll arrows show (UI-TABS-04). */
  readonly scrollable: boolean;
  readonly atStart: boolean;
  readonly atEnd: boolean;
}

/** Sub-pixel rounding tolerance for the scroll edges. */
const EDGE_TOLERANCE = 0.5;

export function overflowEdges(metrics: ScrollMetrics): OverflowEdges {
  const maxScroll = Math.max(0, metrics.scrollWidth - metrics.clientWidth);
  return {
    scrollable: maxScroll > EDGE_TOLERANCE,
    atStart: metrics.scrollLeft <= EDGE_TOLERANCE,
    atEnd: metrics.scrollLeft >= maxScroll - EDGE_TOLERANCE,
  };
}

/** The scroll position that brings a whole tab into view, keeping the current one if it is visible. */
export function revealScrollLeft(metrics: Viewport, tab: Span): number {
  if (tab.left < metrics.scrollLeft) return tab.left;
  const right = tab.left + tab.width;
  if (right > metrics.scrollLeft + metrics.clientWidth) return right - metrics.clientWidth;
  return metrics.scrollLeft;
}

/**
 * The final index of a dragged tab. `slots` are the tabs' extents before the drag, and `centerX`
 * is where the dragged tab's center is now. The result counts the other tabs whose midpoint lies
 * left of that center.
 */
export function dropIndex(from: number, centerX: number, slots: readonly Span[]): number {
  let index = 0;
  slots.forEach((slot, position) => {
    if (position !== from && slot.left + slot.width / 2 < centerX) index++;
  });
  return index;
}

/**
 * How far a tab that is not being dragged moves while the dragged tab goes from `from` to `to`.
 * The tabs between the two positions make room for it.
 */
export function slideOffset(index: number, from: number, to: number, width: number): number {
  if (to > from && index > from && index <= to) return -width;
  if (to < from && index >= to && index < from) return width;
  return 0;
}

/** CSS px per wheel line: a notch is 100 px or 3 lines (WEB-PTR-05). */
const WHEEL_LINE_PX = 100 / 3;

/**
 * How far a wheel event scrolls the tab strip, in CSS px, along its larger axis. Firefox reports
 * mouse wheels in lines (`deltaMode` 1) and Chromium in pixels, so both scroll alike (WEB-PTR-05).
 */
export function wheelScrollPx(
  event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode">,
  pageWidth: number,
): number {
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (event.deltaMode === 1) return delta * WHEEL_LINE_PX;
  if (event.deltaMode === 2) return delta * pageWidth;
  return delta;
}
