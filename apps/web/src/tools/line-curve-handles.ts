import type { CurveKind, LinePoint } from "@openpaint/tools";
import { HandleStore } from "./handle-store";

/** What the canvas shows for a pending or drawn line or curve (TL-LINE-01, TL-FRAME-06). */
export interface LineCurveHandles {
  /** The start and end nubs. */
  readonly start?: LinePoint;
  readonly end?: LinePoint;
  /** The two interior control points, shown for a curve (Spline or Bezier). */
  readonly controls?: readonly [LinePoint, LinePoint];
  /** The curve type, which decides how the handles are joined. */
  readonly curve?: CurveKind;
}

/** The handles of the Line / Curve tool, read by the canvas overlay through `useSyncExternalStore`. */
export const lineCurveHandles = new HandleStore<LineCurveHandles>({});
