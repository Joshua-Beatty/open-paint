import type { Size } from "./geometry";
import { MAX_IMAGE_SIZE, MIN_IMAGE_SIZE } from "./limits";
import type { AffineMatrix } from "./selection-polygons";

/** DOC-IMG-04/05: the axis a whole-image flip mirrors across. */
export type ImageAxis = "horizontal" | "vertical";

/** DOC-IMG-06/07/08: a lossless rotation of the whole image. */
export type ImageRotation = "cw" | "ccw" | "half";

/** DOC-IMG-03: where the existing pixels sit in a resized canvas. */
export const CANVAS_ANCHORS = [
  "topLeft",
  "top",
  "topRight",
  "left",
  "center",
  "right",
  "bottomLeft",
  "bottom",
  "bottomRight",
] as const;

export type CanvasAnchor = (typeof CANVAS_ANCHORS)[number];

type Position = "start" | "middle" | "end";

const ANCHOR_POSITIONS: Record<CanvasAnchor, readonly [Position, Position]> = {
  topLeft: ["start", "start"],
  top: ["middle", "start"],
  topRight: ["end", "start"],
  left: ["start", "middle"],
  center: ["middle", "middle"],
  right: ["end", "middle"],
  bottomLeft: ["start", "end"],
  bottom: ["middle", "end"],
  bottomRight: ["end", "end"],
};

function clampDimension(value: number): number {
  return Math.min(MAX_IMAGE_SIZE, Math.max(MIN_IMAGE_SIZE, Math.round(value)));
}

/** DOC-IMG-02 "By percentage": both sides scaled by `percent`, rounded and kept in range. */
export function scaledSize(current: Size, percent: number): Size {
  if (!Number.isFinite(percent) || percent <= 0) {
    throw new RangeError(`Percentage must be a positive number, got ${percent}.`);
  }
  return {
    width: clampDimension((current.width * percent) / 100),
    height: clampDimension((current.height * percent) / 100),
  };
}

/** A new width. With `keepAspect`, the height follows the width (DOC-IMG-02 aspect lock). */
export function sizeWithWidth(current: Size, width: number, keepAspect: boolean): Size {
  const newWidth = clampDimension(width);
  if (!keepAspect) return { width: newWidth, height: current.height };
  return { width: newWidth, height: clampDimension((current.height * newWidth) / current.width) };
}

/** A new height. With `keepAspect`, the width follows the height (DOC-IMG-02 aspect lock). */
export function sizeWithHeight(current: Size, height: number, keepAspect: boolean): Size {
  const newHeight = clampDimension(height);
  if (!keepAspect) return { width: current.width, height: newHeight };
  return { width: clampDimension((current.width * newHeight) / current.height), height: newHeight };
}

/**
 * DOC-IMG-03: where the top-left pixel of the old canvas lands in the new one. Halves round toward
 * zero, as integer division does, so a shrink can give a negative offset (the pixels are cropped).
 */
export function canvasOffset(anchor: CanvasAnchor, from: Size, to: Size): { x: number; y: number } {
  const [column, row] = ANCHOR_POSITIONS[anchor];
  return {
    x: axisOffset(column, to.width - from.width),
    y: axisOffset(row, to.height - from.height),
  };
}

function axisOffset(position: Position, delta: number): number {
  if (position === "start") return 0;
  if (position === "end") return delta;
  return Math.trunc(delta / 2) || 0;
}

/** The size after a rotation: 90° turns swap width and height. */
export function rotatedSize(size: Size, rotation: ImageRotation): Size {
  return rotation === "half"
    ? { width: size.width, height: size.height }
    : {
        width: size.height,
        height: size.width,
      };
}

/** The matrix that moves selection geometry with a flip of an image of `size` (DOC-IMG-04/05). */
export function flipMatrix(axis: ImageAxis, size: Size): AffineMatrix {
  return axis === "horizontal"
    ? { a: -1, b: 0, c: 0, d: 1, e: size.width, f: 0 }
    : { a: 1, b: 0, c: 0, d: -1, e: 0, f: size.height };
}

/** The matrix that moves selection geometry with a rotation of an image of `size`. */
export function rotationMatrix(rotation: ImageRotation, size: Size): AffineMatrix {
  switch (rotation) {
    case "cw":
      return { a: 0, b: 1, c: -1, d: 0, e: size.height, f: 0 };
    case "ccw":
      return { a: 0, b: -1, c: 1, d: 0, e: 0, f: size.width };
    case "half":
      return { a: -1, b: 0, c: 0, d: -1, e: size.width, f: size.height };
  }
}
