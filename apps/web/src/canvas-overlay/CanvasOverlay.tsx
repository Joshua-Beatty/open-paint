import type { Document } from "@openpaint/document";
import { useTranslation } from "@openpaint/i18n/react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { type MeasureUnit, unitAbbreviation, unitsPerPixel } from "../status/status-model";
import type { StatusStore } from "../status/status-store";
import { cloneSourceMarker } from "../tools/clone-source";
import { gradientHandles } from "../tools/gradient-handles";
import { textHandles } from "../tools/text-handles";
import {
  FRAME_HANDLES,
  type FramePoint,
  RESET_OFFSET_CSS_PX,
  transformFrame,
} from "../tools/transform-frame";
import { wandHandles } from "../tools/wand-handles";
import { zoomRectangle } from "../tools/zoom-rect";
import {
  paintBrushOutline,
  paintCloneSource,
  paintGradientHandles,
  paintGrid,
  paintRuler,
  paintTextFrame,
  paintTransformFrame,
  paintWandHandles,
  paintZoomRectangle,
  type RulerColors,
} from "./draw-overlay";
import {
  brushOutline,
  gridLines,
  gridOpacity,
  type RulerOrientation,
  type RulerTick,
  rulerScale,
  rulerTicks,
  viewPoint,
} from "./overlay-math";
import { useCanvasBacking } from "./use-canvas-backing";
import { useViewLayout } from "./use-view-layout";

/**
 * The pixel grid (UI-VIEW-03) drawn over the engine's canvas. It reads the engine's view layout
 * from the status store and never takes pointer input, so the engine still receives every event.
 */
export function PixelGridOverlay({ store, showGrid }: { store: StatusStore; showGrid: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = useCanvasBacking(ref);
  const layout = useViewLayout(store);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || canvas.width === 0 || canvas.height === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!showGrid || layout === undefined) return;
    const opacity = gridOpacity(layout.zoom, devicePixelRatio);
    if (opacity > 0) paintGrid(ctx, gridLines(layout, size), opacity);
  }, [layout, showGrid, size]);
  return (
    <canvas ref={ref} className="app-canvas-overlay" width={size.width} height={size.height} />
  );
}

/**
 * The brush outline (TL-BRUSH-01) at the pointer, at the brush's size in the view's zoom. It is
 * drawn only while a brush tool is active (`diameter`, in image pixels) and the pointer is on the
 * canvas. It never takes pointer input.
 */
export function BrushCursorOverlay({
  store,
  diameter,
}: {
  store: StatusStore;
  diameter: number | undefined;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = useCanvasBacking(ref);
  const { layout, pointer } = useSyncExternalStore(store.subscribe, () => store.state);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || canvas.width === 0 || canvas.height === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (diameter === undefined || layout === undefined || pointer === undefined) return;
    const outline = brushOutline(diameter, layout.zoom, pointer);
    if (outline !== undefined) paintBrushOutline(ctx, outline);
  }, [layout, pointer, diameter]);
  return (
    <canvas ref={ref} className="app-canvas-overlay" width={size.width} height={size.height} />
  );
}

/**
 * The Clone Stamp's source marker (TL-BRUSH-CS-01): the source point, which is the pointer moved by
 * the offset once a stroke has fixed it. It never takes pointer input.
 */
export function CloneSourceOverlay({ store }: { store: StatusStore }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = useCanvasBacking(ref);
  const { layout, pointer } = useSyncExternalStore(store.subscribe, () => store.state);
  const marker = useSyncExternalStore(cloneSourceMarker.subscribe, () => cloneSourceMarker.state);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || size.width === 0 || size.height === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (marker.offset === undefined || layout === undefined || pointer === undefined) return;
    paintCloneSource(ctx, {
      x: pointer.x + marker.offset.x * layout.zoom,
      y: pointer.y + marker.offset.y * layout.zoom,
      dpr: devicePixelRatio,
    });
  }, [layout, pointer, marker, size]);
  return (
    <canvas ref={ref} className="app-canvas-overlay" width={size.width} height={size.height} />
  );
}

/**
 * The Magic Wand's handles (TL-FRAME-06, TL-SEL-WAND-01): the origin nub at the seed and the move
 * handle at the selection's centre. While a flood computes, a spinner shows at the click point. The
 * overlay never takes pointer input.
 */
export function WandHandlesOverlay({ store }: { store: StatusStore }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = useCanvasBacking(ref);
  const layout = useViewLayout(store);
  const handles = useSyncExternalStore(wandHandles.subscribe, () => wandHandles.state);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || size.width === 0 || size.height === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (layout === undefined) return;
    const seed = handles.seed
      ? viewPoint(layout, { x: handles.seed.x + 0.5, y: handles.seed.y + 0.5 })
      : undefined;
    const move = handles.move ? viewPoint(layout, handles.move) : undefined;
    if (seed === undefined && move === undefined) return;
    paintWandHandles(ctx, { seed, move, dpr: devicePixelRatio });
  }, [layout, handles, size]);
  const busy = handles.busy ? viewPoint(layout, handles.busy) : undefined;
  return (
    <>
      <canvas ref={ref} className="app-canvas-overlay" width={size.width} height={size.height} />
      {busy !== undefined && (
        <div
          className="app-tool-busy"
          aria-hidden="true"
          style={{ left: busy.x / devicePixelRatio, top: busy.y / devicePixelRatio }}
        />
      )}
    </>
  );
}

/**
 * The Gradient tool's handles (TL-GRAD-01, TL-FRAME-06): the start and end nubs and the move handle.
 * It never takes pointer input.
 */
export function GradientHandlesOverlay({ store }: { store: StatusStore }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = useCanvasBacking(ref);
  const layout = useViewLayout(store);
  const handles = useSyncExternalStore(gradientHandles.subscribe, () => gradientHandles.state);
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
    const move = at(handles.move);
    if (start === undefined && end === undefined && move === undefined) return;
    paintGradientHandles(ctx, { start, end, move, dpr: devicePixelRatio });
  }, [layout, handles, size]);
  return (
    <canvas ref={ref} className="app-canvas-overlay" width={size.width} height={size.height} />
  );
}

/**
 * The transform frame of Move Selected Pixels and Move Selection (TL-MOVE-01): the outline, the scale
 * handles, the rotation anchor and its reset button. It never takes pointer input.
 */
export function TransformFrameOverlay({ store }: { store: StatusStore }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = useCanvasBacking(ref);
  const layout = useViewLayout(store);
  const frame = useSyncExternalStore(transformFrame.subscribe, () => transformFrame.state);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || size.width === 0 || size.height === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (layout === undefined || frame === undefined) return;
    const at = (point: FramePoint) => ({
      x: layout.originX + point.x * layout.zoom,
      y: layout.originY + point.y * layout.zoom,
    });
    const anchor = at(frame.anchor);
    const resetOffset = RESET_OFFSET_CSS_PX * devicePixelRatio;
    paintTransformFrame(ctx, {
      corners: frame.corners.map(at),
      handles: FRAME_HANDLES.map((handle) => at(frame.handles[handle])),
      anchor,
      reset: { x: anchor.x + resetOffset, y: anchor.y + resetOffset },
      outline: frame.outline !== false,
      dpr: devicePixelRatio,
    });
  }, [layout, frame, size]);
  return (
    <canvas ref={ref} className="app-canvas-overlay" width={size.width} height={size.height} />
  );
}

/**
 * The outline of a Zoom tool rectangle drag (TL-ZOOM-01), in image pixels from the store. It never
 * takes pointer input.
 */
export function ZoomRectangleOverlay({ store }: { store: StatusStore }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = useCanvasBacking(ref);
  const layout = useViewLayout(store);
  const rect = useSyncExternalStore(zoomRectangle.subscribe, () => zoomRectangle.state);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || size.width === 0 || size.height === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (layout === undefined || rect === undefined) return;
    const start = viewPoint(layout, { x: rect.x, y: rect.y });
    const end = viewPoint(layout, { x: rect.x + rect.width, y: rect.y + rect.height });
    if (start === undefined || end === undefined) return;
    paintZoomRectangle(
      ctx,
      { x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y },
      devicePixelRatio,
    );
  }, [layout, rect, size]);
  return (
    <canvas ref={ref} className="app-canvas-overlay" width={size.width} height={size.height} />
  );
}

export interface RulersProps {
  readonly store: StatusStore;
  readonly doc: Document;
  readonly unit: MeasureUnit;
}

/**
 * The rulers along the top and left of the canvas (UI-VIEW-04): ticks in the chosen unit (UI-VIEW-05),
 * the selection's extent, the cursor marker, and a units box in the corner.
 */
export function Rulers({ store, doc, unit }: RulersProps) {
  const t = useTranslation();
  const perPixel = unitsPerPixel(doc.resolution, unit);
  const bounds = doc.selection.isEmpty ? undefined : doc.selection.bounds();
  return (
    <>
      <div className="app-ruler-corner" aria-hidden="true">
        {unitAbbreviation(unit, t)}
      </div>
      <Ruler
        orientation="horizontal"
        store={store}
        unit={unit}
        unitsPerPixel={perPixel.x}
        selectionFrom={bounds?.x}
        selectionTo={bounds && bounds.x + bounds.width}
      />
      <Ruler
        orientation="vertical"
        store={store}
        unit={unit}
        unitsPerPixel={perPixel.y}
        selectionFrom={bounds?.y}
        selectionTo={bounds && bounds.y + bounds.height}
      />
    </>
  );
}

/**
 * The Text tool's box, caret and move handle (TL-TEXT-01), in image pixels from the text handles.
 * It never takes pointer input.
 */
export function TextFrameOverlay({ store }: { store: StatusStore }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = useCanvasBacking(ref);
  const layout = useViewLayout(store);
  const handles = useSyncExternalStore(textHandles.subscribe, () => textHandles.state);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || size.width === 0 || size.height === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (layout === undefined) return;
    const at = (point: { x: number; y: number }) => ({
      x: layout.originX + point.x * layout.zoom,
      y: layout.originY + point.y * layout.zoom,
    });
    const { box, caret, handle } = handles;
    if (box === undefined && caret === undefined && handle === undefined) return;
    const corner = box === undefined ? undefined : at(box);
    const far = box === undefined ? undefined : at({ x: box.x + box.width, y: box.y + box.height });
    paintTextFrame(ctx, {
      ...(corner !== undefined && far !== undefined
        ? {
            box: {
              x: corner.x,
              y: corner.y,
              width: far.x - corner.x,
              height: far.y - corner.y,
            },
          }
        : {}),
      ...(caret === undefined
        ? {}
        : { caret: { ...at(caret), height: caret.height * layout.zoom } }),
      ...(handle === undefined ? {} : { handle: at(handle) }),
      dpr: devicePixelRatio,
    });
  }, [layout, handles, size]);
  return (
    <canvas ref={ref} className="app-canvas-overlay" width={size.width} height={size.height} />
  );
}

interface RulerProps {
  readonly orientation: RulerOrientation;
  readonly store: StatusStore;
  readonly unit: MeasureUnit;
  readonly unitsPerPixel: number;
  readonly selectionFrom: number | undefined;
  readonly selectionTo: number | undefined;
}

function colorVariable(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback;
}

function Ruler({
  orientation,
  store,
  unit,
  unitsPerPixel: pixelUnits,
  selectionFrom,
  selectionTo,
}: RulerProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const size = useCanvasBacking(ref);
  const layout = useViewLayout(store);
  // The cursor marker follows the pointer by moving an element, so a pointer move neither
  // re-renders nor repaints the ruler (L3).
  useEffect(() => {
    const place = () => {
      const marker = markerRef.current;
      if (marker === null) return;
      const { pointer } = store.state;
      if (pointer === undefined) {
        marker.style.display = "none";
        return;
      }
      const at =
        Math.round(orientation === "horizontal" ? pointer.x : pointer.y) / devicePixelRatio;
      marker.style.display = "";
      marker.style.transform =
        orientation === "horizontal" ? `translateX(${at}px)` : `translateY(${at}px)`;
    };
    place();
    return store.subscribe(place);
  }, [store, orientation]);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || size.width === 0 || size.height === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const horizontal = orientation === "horizontal";
    const length = horizontal ? size.width : size.height;
    const thickness = horizontal ? size.height : size.width;
    const dpr = devicePixelRatio;
    const style = getComputedStyle(canvas);
    const colors: RulerColors = {
      background: colorVariable(style, "--ruler-background", "#ececf0"),
      text: colorVariable(style, "--ruler-text", "#3a3a42"),
      tick: colorVariable(style, "--ruler-tick", "#6a6a74"),
      selection: colorVariable(style, "--ruler-selection", "rgba(31, 111, 235, 0.25)"),
      marker: colorVariable(style, "--ruler-marker", "#d93636"),
    };
    let ticks: RulerTick[] = [];
    let selection: { start: number; end: number } | undefined;
    if (layout !== undefined) {
      const origin = horizontal ? layout.originX : layout.originY;
      const scale = rulerScale(unit, pixelUnits, layout.zoom, dpr);
      ticks = rulerTicks(scale, pixelUnits, layout.zoom, origin, length);
      if (selectionFrom !== undefined && selectionTo !== undefined) {
        selection = {
          start: origin + selectionFrom * layout.zoom,
          end: origin + selectionTo * layout.zoom,
        };
      }
    }
    paintRuler(ctx, {
      orientation,
      length,
      thickness,
      dpr,
      font: `${Math.round(10 * dpr)}px ${style.fontFamily}`,
      colors,
      ticks,
      selection,
    });
  }, [orientation, layout, unit, pixelUnits, selectionFrom, selectionTo, size]);
  return (
    <>
      <canvas
        ref={ref}
        className={`app-ruler app-ruler-${orientation}`}
        width={size.width}
        height={size.height}
      />
      <div
        ref={markerRef}
        className={`app-ruler-marker app-ruler-marker-${orientation}`}
        aria-hidden="true"
      />
    </>
  );
}
