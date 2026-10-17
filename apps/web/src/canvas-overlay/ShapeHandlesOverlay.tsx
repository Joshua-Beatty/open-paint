import { useEffect, useRef, useSyncExternalStore } from "react";
import type { StatusStore } from "../status/status-store";
import { shapeHandles } from "../tools/shape-handles";
import { paintShapeHandles } from "./draw-overlay";
import { viewPoint } from "./overlay-math";
import { useCanvasBacking } from "./use-canvas-backing";
import { useViewLayout } from "./use-view-layout";

/**
 * The property handles of the Shapes tool (TL-SHAPE-01, TL-FRAME-06): the corner size handle and
 * the callout tail handle. The shape's frame is the transform frame overlay. It never takes pointer
 * input.
 */
export function ShapeHandlesOverlay({ store }: { store: StatusStore }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = useCanvasBacking(ref);
  const layout = useViewLayout(store);
  const handles = useSyncExternalStore(shapeHandles.subscribe, () => shapeHandles.state);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || size.width === 0 || size.height === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (layout === undefined) return;
    const radius = handles.radius === undefined ? undefined : viewPoint(layout, handles.radius);
    const tail = handles.tail === undefined ? undefined : viewPoint(layout, handles.tail);
    if (radius === undefined && tail === undefined) return;
    paintShapeHandles(ctx, { radius, tail, dpr: size.scale });
  }, [layout, handles, size]);
  return (
    <canvas ref={ref} className="app-canvas-overlay" width={size.width} height={size.height} />
  );
}
