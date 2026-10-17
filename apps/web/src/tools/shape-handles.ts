import type { LinePoint } from "@openpaint/tools";
import { HandleStore } from "./handle-store";

/**
 * The property handles of a pending or drawn shape, in canvas pixels (TL-SHAPE-01, TL-FRAME-06).
 * The shape's box is drawn by the transform frame (`transformFrame`).
 */
export interface ShapeHandles {
  /** The corner size handle, shown for the shapes that have one. */
  readonly radius?: LinePoint;
  /** The callout tail handle, shown for the shapes that have one. */
  readonly tail?: LinePoint;
}

/** The handles of the Shapes tool, read by the canvas overlay through `useSyncExternalStore`. */
export const shapeHandles = new HandleStore<ShapeHandles>({});
