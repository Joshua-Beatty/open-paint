import { type Rect, rectFromEdges } from "./geometry";

/** DOC-DOC-01: image width and height range in pixels. */
export const MIN_IMAGE_SIZE = 1;
export const MAX_IMAGE_SIZE = 262_144;

/** DOC-DOC-01: workspace coordinate space for content outside the image, e.g. pasted pixels. */
export const WORKSPACE_MIN_COORD = -524_288;
export const WORKSPACE_MAX_COORD = 524_288;
export const WORKSPACE_RECT: Rect = Object.freeze(
  rectFromEdges(WORKSPACE_MIN_COORD, WORKSPACE_MIN_COORD, WORKSPACE_MAX_COORD, WORKSPACE_MAX_COORD),
);

export function isValidImageDimension(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_IMAGE_SIZE && value <= MAX_IMAGE_SIZE;
}

export function isValidImageSize(width: number, height: number): boolean {
  return isValidImageDimension(width) && isValidImageDimension(height);
}
