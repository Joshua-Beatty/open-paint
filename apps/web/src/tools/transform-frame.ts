import {
  type AffineMatrix,
  applyAffine,
  composeAffine,
  invertAffine,
  type Rect,
  rotationAboutAffine,
  scalingAboutAffine,
  translationAffine,
} from "@openpaint/document";
import {
  BUTTON_CURSOR,
  GRAB_CURSOR,
  GRABBING_CURSOR,
  HANDLE_HIT_CSS_PX,
  MOVE_CURSOR,
  resizeCursor,
  rotateCursor,
} from "./cursors";

/** A point in image pixels. */
export interface FramePoint {
  readonly x: number;
  readonly y: number;
}

/** The eight scale handles of the transform frame (TL-MOVE-01), by compass position. */
export const FRAME_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;

export type FrameHandle = (typeof FRAME_HANDLES)[number];

/**
 * The radius of a handle's or the anchor's hit area, in CSS pixels (TL-FRAME-06), as every tool's
 * handles. It is in screen space, so the handles are as easy to grab at any zoom.
 */
export const FRAME_HIT_RADIUS = HANDLE_HIT_CSS_PX;

/** How far outside the frame a press still rotates it, in CSS pixels (TL-MOVE-01 rotate box). */
export const ROTATE_ZONE = 16;

/**
 * How far the reset button sits from the anchor along each axis, in CSS pixels. It is on screen, so
 * the button stays clear of the anchor's hit area at any zoom.
 */
export const RESET_OFFSET_CSS_PX = 14;

/** The smallest scale factor, so the content never collapses to zero size (TL-MOVE-01). */
export const MIN_SCALE = 1e-7;

/** The rotation step while Shift is held (TL-MOVE-01). */
export const ROTATION_SNAP = Math.PI / 12;

/** What a press on the frame does. */
export type FrameHit =
  | { readonly kind: "anchor" }
  | { readonly kind: "reset" }
  | { readonly kind: "handle"; readonly handle: FrameHandle }
  | { readonly kind: "move" }
  | { readonly kind: "rotate" };

/** The frame as the canvas draws it, in image pixels. */
export interface FrameGeometry {
  /** The corners of the source rectangle, clockwise from its top-left corner. */
  readonly corners: readonly FramePoint[];
  readonly handles: Readonly<Record<FrameHandle, FramePoint>>;
  readonly anchor: FramePoint;
}

/** The reset button's centre in image pixels, beside the anchor at the view's zoom `scale`. */
export function resetPoint(anchor: FramePoint, scale = 1): FramePoint {
  const offset = RESET_OFFSET_CSS_PX / scale;
  return { x: anchor.x + offset, y: anchor.y + offset };
}

/** The transform and rotation anchor when a gesture starts. */
export interface FrameStart {
  readonly m: AffineMatrix;
  /** The rotation anchor, in the source's coordinates. */
  readonly anchor: FramePoint;
  /** The pointer's position when the gesture started, in image pixels. */
  readonly press: FramePoint;
}

export type FrameGesture =
  | { readonly kind: "move"; readonly start: FrameStart }
  | { readonly kind: "rotate"; readonly start: FrameStart }
  | { readonly kind: "scale"; readonly start: FrameStart; readonly handle: FrameHandle }
  | { readonly kind: "anchor"; readonly start: FrameStart };

export interface GestureModifiers {
  /** Constrains a scale to the aspect ratio and a rotation to 15 degree steps. */
  readonly shift: boolean;
  /** Scales uniformly about the centre of the source. */
  readonly alt: boolean;
}

/** The result of a gesture: the new transform and the rotation anchor in the source's coordinates. */
export interface GestureResult {
  readonly m: AffineMatrix;
  readonly anchor: FramePoint;
}

function handleDirection(handle: FrameHandle): {
  readonly dx: -1 | 0 | 1;
  readonly dy: -1 | 0 | 1;
} {
  const dx = handle.includes("w") ? -1 : handle.includes("e") ? 1 : 0;
  const dy = handle.includes("n") ? -1 : handle.includes("s") ? 1 : 0;
  return { dx, dy };
}

/** A handle's position in the source's coordinates. */
function handleInSource(source: Rect, handle: FrameHandle): FramePoint {
  const { dx, dy } = handleDirection(handle);
  return {
    x: dx < 0 ? source.x : dx > 0 ? source.x + source.width : source.x + source.width / 2,
    y: dy < 0 ? source.y : dy > 0 ? source.y + source.height : source.y + source.height / 2,
  };
}

function centerOf(source: Rect): FramePoint {
  return { x: source.x + source.width / 2, y: source.y + source.height / 2 };
}

/** The frame's geometry under `m`, with the rotation anchor given in the source's coordinates. */
export function frameGeometry(source: Rect, m: AffineMatrix, anchor: FramePoint): FrameGeometry {
  const at = (p: FramePoint): FramePoint => applyAffine(m, p.x, p.y);
  const handles = Object.fromEntries(
    FRAME_HANDLES.map((handle) => [handle, at(handleInSource(source, handle))]),
  ) as Record<FrameHandle, FramePoint>;
  return {
    corners: [
      at({ x: source.x, y: source.y }),
      at({ x: source.x + source.width, y: source.y }),
      at({ x: source.x + source.width, y: source.y + source.height }),
      at({ x: source.x, y: source.y + source.height }),
    ],
    handles,
    anchor: at(anchor),
  };
}

function distance(a: FramePoint, b: FramePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The distance from `p` to the nearest edge of the closed polygon `corners`. */
function distanceToOutline(p: FramePoint, corners: readonly FramePoint[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    if (a === undefined || b === undefined) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared === 0
        ? 0
        : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
    best = Math.min(best, distance(p, { x: a.x + t * dx, y: a.y + t * dy }));
  }
  return best;
}

/**
 * What a press at `p` does (TL-MOVE-01). The anchor, the reset button and the nearest handle come first.
 * A right-button press rotates from anywhere. A left press inside the frame moves it, and one just
 * outside the frame rotates it. Anything else does nothing and returns undefined. `scale` is the
 * view's zoom in CSS pixels per image pixel, since the hit areas are measured on screen.
 */
export function hitFrame(
  source: Rect,
  m: AffineMatrix,
  anchor: FramePoint,
  p: FramePoint,
  button: number,
  scale = 1,
): FrameHit | undefined {
  const geometry = frameGeometry(source, m, anchor);
  const radius = FRAME_HIT_RADIUS / scale;
  if (distance(p, geometry.anchor) <= radius) return { kind: "anchor" };
  if (distance(p, resetPoint(geometry.anchor, scale)) <= radius) return { kind: "reset" };
  let nearest: { readonly handle: FrameHandle; readonly distance: number } | undefined;
  for (const handle of FRAME_HANDLES) {
    const d = distance(p, geometry.handles[handle]);
    if (d <= radius && (nearest === undefined || d < nearest.distance)) {
      nearest = { handle, distance: d };
    }
  }
  if (nearest !== undefined) return { kind: "handle", handle: nearest.handle };
  if (button === 2) return { kind: "rotate" };
  const local = applyAffine(invertAffine(m), p.x, p.y);
  const inside =
    local.x >= source.x &&
    local.x <= source.x + source.width &&
    local.y >= source.y &&
    local.y <= source.y + source.height;
  if (inside) return { kind: "move" };
  return distanceToOutline(p, geometry.corners) <= ROTATE_ZONE / scale
    ? { kind: "rotate" }
    : undefined;
}

/**
 * The direction a scale handle moves in image pixels under `m`: its outward direction in the
 * source, mapped through `m`, so the cursor follows a rotated or flipped frame.
 */
export function handleAxis(m: AffineMatrix, handle: FrameHandle): FramePoint {
  const { dx, dy } = handleDirection(handle);
  const ux = Math.hypot(m.a, m.b) || 1;
  const vy = Math.hypot(m.c, m.d) || 1;
  // Each source axis is normalised, so a wide frame still shows its corners on the diagonal.
  return {
    x: (dx * m.a) / ux + (dy * m.c) / vy,
    y: (dx * m.b) / ux + (dy * m.d) / vy,
  };
}

/** The rotate cursor at `p`, bulging away from the frame's centre. */
function rotateCursorAt(source: Rect, m: AffineMatrix, p: FramePoint): string {
  const center = centerOf(source);
  const c = applyAffine(m, center.x, center.y);
  return rotateCursor(p.x - c.x, p.y - c.y);
}

/**
 * The cursor of the frame part a hit names (TL-MOVE-01, TL-FRAME-06): the move arrows inside, a
 * rotate arrow outside, a resize arrow along each handle's direction, and an open hand on the
 * rotation anchor. `p` is the pointer.
 */
export function frameCursor(
  hit: FrameHit | undefined,
  source: Rect,
  m: AffineMatrix,
  p: FramePoint,
): string | undefined {
  switch (hit?.kind) {
    case undefined:
      return undefined;
    case "anchor":
      return GRAB_CURSOR;
    case "reset":
      return BUTTON_CURSOR;
    case "move":
      return MOVE_CURSOR;
    case "rotate":
      return rotateCursorAt(source, m, p);
    case "handle": {
      const axis = handleAxis(m, hit.handle);
      return resizeCursor(axis.x, axis.y);
    }
  }
}

/**
 * The cursor while a gesture is dragged: the one its press showed, under the frame's current
 * transform `m`, with a closed hand on the anchor.
 */
export function gestureCursor(
  gesture: FrameGesture,
  source: Rect,
  m: AffineMatrix,
  p: FramePoint,
): string {
  switch (gesture.kind) {
    case "move":
      return MOVE_CURSOR;
    case "anchor":
      return GRABBING_CURSOR;
    case "rotate":
      return rotateCursorAt(source, m, p);
    case "scale": {
      const axis = handleAxis(m, gesture.handle);
      return resizeCursor(axis.x, axis.y);
    }
  }
}

/** The gesture a hit starts, from the state at the press. */
export function gestureFor(hit: FrameHit, start: FrameStart): FrameGesture | undefined {
  switch (hit.kind) {
    case "move":
      return { kind: "move", start };
    case "rotate":
      return { kind: "rotate", start };
    case "handle":
      return { kind: "scale", start, handle: hit.handle };
    case "anchor":
      return { kind: "anchor", start };
    case "reset":
      return undefined;
  }
}

/** A scale factor that keeps its sign and never falls below `MIN_SCALE` in size. */
function clampScale(value: number): number {
  if (Math.abs(value) >= MIN_SCALE) return value;
  return value < 0 ? -MIN_SCALE : MIN_SCALE;
}

/** The angle from `from` to `to`, wrapped to (-pi, pi]. */
function turnBetween(from: FramePoint, to: FramePoint, pivot: FramePoint): number {
  const before = Math.atan2(from.y - pivot.y, from.x - pivot.x);
  const after = Math.atan2(to.y - pivot.y, to.x - pivot.x);
  let turn = after - before;
  while (turn > Math.PI) turn -= 2 * Math.PI;
  while (turn <= -Math.PI) turn += 2 * Math.PI;
  return turn;
}

/**
 * The transform and anchor a gesture gives when the pointer is at `p` (TL-MOVE-01). A move rounds
 * its offset to whole pixels, so moved pixels keep their exact values. A scale works in the
 * source's own axes, so it follows the frame's rotation. Shift keeps the aspect ratio, or snaps a
 * rotation to 15 degrees. Alt scales uniformly about the centre.
 */
export function gestureResult(
  source: Rect,
  gesture: FrameGesture,
  p: FramePoint,
  modifiers: GestureModifiers,
): GestureResult {
  const { start } = gesture;
  switch (gesture.kind) {
    case "move": {
      const dx = Math.round(p.x - start.press.x);
      const dy = Math.round(p.y - start.press.y);
      return { m: composeAffine(translationAffine(dx, dy), start.m), anchor: start.anchor };
    }
    case "rotate": {
      const pivot = applyAffine(start.m, start.anchor.x, start.anchor.y);
      let turn = turnBetween(start.press, p, pivot);
      if (modifiers.shift) turn = Math.round(turn / ROTATION_SNAP) * ROTATION_SNAP;
      const rotation = rotationAboutAffine(pivot.x, pivot.y, turn);
      return { m: composeAffine(rotation, start.m), anchor: start.anchor };
    }
    case "scale": {
      const { dx, dy } = handleDirection(gesture.handle);
      const local = applyAffine(invertAffine(start.m), p.x, p.y);
      const center = centerOf(source);
      const opposite: FramePoint = {
        x: dx < 0 ? source.x + source.width : dx > 0 ? source.x : center.x,
        y: dy < 0 ? source.y + source.height : dy > 0 ? source.y : center.y,
      };
      const pivot = modifiers.alt ? center : opposite;
      const handle = handleInSource(source, gesture.handle);
      let sx = dx === 0 ? 1 : (local.x - pivot.x) / (handle.x - pivot.x);
      let sy = dy === 0 ? 1 : (local.y - pivot.y) / (handle.y - pivot.y);
      if (modifiers.shift || modifiers.alt) {
        const uniform = dx === 0 ? sy : dy === 0 ? sx : Math.abs(sx) >= Math.abs(sy) ? sx : sy;
        sx = uniform;
        sy = uniform;
      }
      const scale = scalingAboutAffine(pivot.x, pivot.y, clampScale(sx), clampScale(sy));
      return { m: composeAffine(start.m, scale), anchor: start.anchor };
    }
    case "anchor":
      return { m: start.m, anchor: applyAffine(invertAffine(start.m), p.x, p.y) };
  }
}

/**
 * The state the frame overlay draws: the geometry in image pixels, and whether its outline is drawn.
 * Selections keep their outline; a pending shape shows only its handles, so the outline never hides
 * the shape's own stroke.
 */
export type TransformFrameState = FrameGeometry & { readonly outline?: boolean };

/** The frame the canvas draws while a move tool holds a result. Read through `useSyncExternalStore`. */
class TransformFrameStore {
  #state: TransformFrameState | undefined;
  readonly #listeners = new Set<() => void>();

  get state(): TransformFrameState | undefined {
    return this.#state;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  set(state: TransformFrameState | undefined): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

export const transformFrame = new TransformFrameStore();
