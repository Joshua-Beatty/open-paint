import {
  type AffineMatrix,
  applyAffine,
  composeAffine,
  IDENTITY_AFFINE,
  invertAffine,
  type Rect,
  rotationAboutAffine,
} from "@openpaint/document";
import type { DragBox, LinePoint } from "@openpaint/tools";
import { ROTATION_SNAP } from "./transform-frame";

/**
 * Where a pending shape sits (TL-SHAPE-01): its box in the shape's own, unrotated axes, turned by
 * `angle` radians (clockwise on screen) about the box's centre, and its rotation anchor as a
 * fraction of the box, so it moves and scales with the shape.
 */
export interface ShapePlacement {
  readonly box: DragBox;
  readonly angle: number;
  readonly pivot: LinePoint;
}

/** The anchor of a fresh shape: its centre. */
export const CENTER_PIVOT: LinePoint = { x: 0.5, y: 0.5 };

/** The kinds of frame gesture a shape takes (TL-MOVE-01). */
export type ShapeGestureKind = "move" | "rotate" | "scale" | "anchor";

/** The box as a rectangle, which the transform frame is drawn on. */
export function boxRect(box: DragBox): Rect {
  return { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top };
}

function centerOf(box: DragBox): LinePoint {
  return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
}

/** The map from the shape's own axes to the image: the turn about the box's centre. */
export function placementTransform(placement: ShapePlacement): AffineMatrix {
  if (placement.angle === 0) return IDENTITY_AFFINE;
  const center = centerOf(placement.box);
  return rotationAboutAffine(center.x, center.y, placement.angle);
}

/** The rotation anchor in the shape's own axes. */
export function placementAnchor(placement: ShapePlacement): LinePoint {
  const { box, pivot } = placement;
  return {
    x: box.left + pivot.x * (box.right - box.left),
    y: box.top + pivot.y * (box.bottom - box.top),
  };
}

/** An angle wrapped to (-pi, pi]. */
export function wrapAngle(angle: number): number {
  let turn = angle % (2 * Math.PI);
  if (turn > Math.PI) turn -= 2 * Math.PI;
  if (turn <= -Math.PI) turn += 2 * Math.PI;
  return turn;
}

/** The angle snapped to 15 degree steps (Shift, TL-MOVE-01), measured from the image's axes. */
export function snapAngle(angle: number): number {
  return wrapAngle(Math.round(angle / ROTATION_SNAP) * ROTATION_SNAP);
}

/** The box moved by (`dx`, `dy`). */
function shifted(box: DragBox, dx: number, dy: number): DragBox {
  return { left: box.left + dx, top: box.top + dy, right: box.right + dx, bottom: box.bottom + dy };
}

/**
 * The placement a frame gesture gives (TL-MOVE-01). `m` and `anchor` are the gesture's result, a
 * transform of the box the gesture started on and the anchor in that box's axes, as
 * `gestureResult` returns them. A move keeps whole-pixel offsets. A rotation turns the shape about
 * its anchor, snapped to 15 degree steps of the shape's own angle with `snap`. A scale resizes the
 * box in the shape's own axes, so it follows the rotation, with its edges on whole pixels of those
 * axes. The geometry stays a box and an angle, so the shape is drawn again from its path, never
 * resampled.
 */
export function placeByGesture(
  from: ShapePlacement,
  kind: ShapeGestureKind,
  m: AffineMatrix,
  anchor: LinePoint,
  snap: boolean,
): ShapePlacement {
  const before = placementTransform(from);
  switch (kind) {
    case "move": {
      // The gesture moves the transform; the offset is a whole pixel move of the box.
      const delta = composeAffine(m, invertAffine(before));
      return { ...from, box: shifted(from.box, Math.round(delta.e), Math.round(delta.f)) };
    }
    case "rotate": {
      const delta = composeAffine(m, invertAffine(before));
      const raw = from.angle + Math.atan2(delta.b, delta.a);
      const angle = snap ? snapAngle(raw) : wrapAngle(raw);
      // The centre swings about the anchor; the turn about the centre is the shape's angle. The
      // offset is computed from the centre's distance to the anchor, so it is exactly zero when
      // the anchor is the centre.
      const center = centerOf(from.box);
      const anchorAt = placementAnchor(from);
      const ax = anchorAt.x - center.x;
      const ay = anchorAt.y - center.y;
      // The centre less the anchor on the image: the anchor's offset from the centre, turned.
      const dx = -(Math.cos(from.angle) * ax - Math.sin(from.angle) * ay);
      const dy = -(Math.sin(from.angle) * ax + Math.cos(from.angle) * ay);
      const turn = angle - from.angle;
      const cos = Math.cos(turn);
      const sin = Math.sin(turn);
      return {
        ...from,
        box: shifted(from.box, cos * dx - sin * dy - dx, sin * dx + cos * dy - dy),
        angle,
      };
    }
    case "scale": {
      // The gesture scales in the box's own axes: m = before * s.
      const s = composeAffine(invertAffine(before), m);
      const a = applyAffine(s, from.box.left, from.box.top);
      const b = applyAffine(s, from.box.right, from.box.bottom);
      const box: DragBox = {
        left: Math.round(Math.min(a.x, b.x)),
        top: Math.round(Math.min(a.y, b.y)),
        right: Math.round(Math.max(a.x, b.x)),
        bottom: Math.round(Math.max(a.y, b.y)),
      };
      if (from.angle === 0) return { ...from, box };
      // The resized box, still turned about the old centre, is the new box turned about its own.
      const old = centerOf(from.box);
      const center = centerOf(box);
      const ox = center.x - old.x;
      const oy = center.y - old.y;
      const cos = Math.cos(from.angle);
      const sin = Math.sin(from.angle);
      return { ...from, box: shifted(box, cos * ox - sin * oy - ox, sin * ox + cos * oy - oy) };
    }
    case "anchor": {
      const { box } = from;
      const width = box.right - box.left;
      const height = box.bottom - box.top;
      return {
        ...from,
        pivot: { x: (anchor.x - box.left) / width, y: (anchor.y - box.top) / height },
      };
    }
  }
}

/** Whether `p` lies inside the rings under the even-odd rule, as the shapes are filled. */
export function insideRings(rings: readonly (readonly LinePoint[])[], p: LinePoint): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (a === undefined || b === undefined) continue;
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** The distance from `p` to the nearest edge of the closed rings. */
export function distanceToRings(rings: readonly (readonly LinePoint[])[], p: LinePoint): number {
  let best = Number.POSITIVE_INFINITY;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j];
      const b = ring[i];
      if (a === undefined || b === undefined) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = dx * dx + dy * dy;
      const t =
        length === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length));
      best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
    }
  }
  return best;
}

/**
 * Whether a press at `p` is on the shape's body: inside the area its outline encloses, or within
 * `reach` image pixels of the outline (half the pen width plus the click dead zone), so a thin
 * outline is as easy to pick up as a filled shape. Rings and `p` are in the same axes.
 */
export function onShapeBody(
  rings: readonly (readonly LinePoint[])[],
  p: LinePoint,
  reach: number,
): boolean {
  return insideRings(rings, p) || distanceToRings(rings, p) <= reach;
}
