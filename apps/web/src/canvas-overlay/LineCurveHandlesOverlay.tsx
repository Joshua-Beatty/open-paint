import { useEffect, useRef, useSyncExternalStore } from "react";
import type { StatusStore } from "../status/status-store";
import { lineCurveHandles } from "../tools/line-curve-handles";
import { paintLineCurveHandles } from "./draw-overlay";
import { viewPoint } from "./overlay-math";
import { useCanvasBacking } from "./use-canvas-backing";
import { useViewLayout } from "./use-view-layout";

/**
 * The handles of the Line / Curve tool (TL-LINE-01, TL-FRAME-06): the endpoint nubs and, for a curve,
 * the two control points. It never takes pointer input.
 */
export function LineCurveHandlesOverlay({ store }: { store: StatusStore }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = useCanvasBacking(ref);
  const layout = useViewLayout(store);
  const handles = useSyncExternalStore(lineCurveHandles.subscribe, () => lineCurveHandles.state);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || size.width === 0 || size.height === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (layout === undefined) return;
    const at = (point: { x: number; y: number } | undefined) =>
      point === undefined ? undefined : viewPoint(layout, point);
    const start = at(handles.start);
    const end = at(handles.end);
    const [first, second] = handles.controls ?? [];
    const firstControl = at(first);
    const secondControl = at(second);
    const controls =
      firstControl !== undefined && secondControl !== undefined
        ? ([firstControl, secondControl] as const)
        : undefined;
    if (start === undefined && end === undefined && controls === undefined) return;
    paintLineCurveHandles(ctx, { start, end, controls, dpr: devicePixelRatio });
  }, [layout, handles, size]);
  return (
    <canvas ref={ref} className="app-canvas-overlay" width={size.width} height={size.height} />
  );
}
