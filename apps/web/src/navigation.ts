/**
 * Whether the user is moving the view: a pan drag is held, or a wheel, pinch or key moved the view
 * moments ago. Background work (thumbnails, checkpoints) waits meanwhile, so it never takes the
 * main thread from a pan or zoom (L5).
 */

/** How long after the last view input the view still counts as moving. */
export const NAVIGATION_QUIET_MS = 250;

let dragging = false;
let lastInput = Number.NEGATIVE_INFINITY;

/** A wheel, pinch or key moved the view. */
export function noteViewInput(now = performance.now()): void {
  lastInput = now;
}

/** A pan drag started or ended. */
export function setViewDragging(held: boolean, now = performance.now()): void {
  dragging = held;
  lastInput = now;
}

export function navigating(now = performance.now()): boolean {
  return dragging || now - lastInput < NAVIGATION_QUIET_MS;
}
