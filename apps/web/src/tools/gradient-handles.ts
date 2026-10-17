import { HandleStore } from "./handle-store";

/** A point in image pixels, which need not be whole. */
export interface HandlePoint {
  readonly x: number;
  readonly y: number;
}

/** What the canvas shows for a pending gradient (TL-GRAD-01, TL-FRAME-06). */
export interface GradientHandles {
  /** The start nub. */
  readonly start?: HandlePoint;
  /** The end nub. */
  readonly end?: HandlePoint;
  /** The move handle, at the midpoint of the gradient line. */
  readonly move?: HandlePoint;
}

/** The handles of the Gradient tool, read by the canvas overlay through `useSyncExternalStore`. */
export const gradientHandles = new HandleStore<GradientHandles>({});
