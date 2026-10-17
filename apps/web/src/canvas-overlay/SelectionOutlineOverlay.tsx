import type { Document } from "@openpaint/document";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { perfMonitor } from "../perf/perf-monitor";
import type { StatusStore } from "../status/status-store";
import {
  ANT_STEP_MS,
  antDash,
  antOffset,
  antTile,
  outlinePath,
  outlineRuns,
  paintCrispOutline,
  paintSelectionOutline,
} from "./selection-outline";
import { useCanvasBacking } from "./use-canvas-backing";
import { useViewLayout } from "./use-view-layout";

/** The repeating ant pattern of a crisp outline, for stripes `dash` device pixels wide. */
function antPattern(ctx: CanvasRenderingContext2D, dash: number): CanvasPattern | null {
  const tile = window.document.createElement("canvas");
  tile.width = dash * 2;
  tile.height = dash * 2;
  tile.getContext("2d")?.putImageData(new ImageData(antTile(dash), dash * 2, dash * 2), 0, 0);
  return ctx.createPattern(tile, "repeat");
}

/** The selection runs as one path of pixel-aligned rectangles. */
function runsPath(runs: readonly number[]): Path2D {
  const path = new Path2D();
  for (let i = 0; i + 3 < runs.length; i += 4) {
    path.rect(runs[i] ?? 0, runs[i + 1] ?? 0, runs[i + 2] ?? 0, runs[i + 3] ?? 0);
  }
  return path;
}

/**
 * The selection outline (DOC-SEL-04): marching ants along the selection's edges and a tint inside
 * it, over the engine's canvas. It follows every selection change, including a selection tool's
 * live preview while it draws. The ants stand still when animations are off (WEB-UI-04). With
 * `antialiased` off the ants are crisp one-pixel runs, which also step at a fraction of the cost.
 * Each step of the ants repaints this 2D canvas directly, without a React render. The ants keep
 * marching while a tool draws (owner request): a step only strokes the outline, and drawing into a
 * 2D overlay canvas doesn't make browsers redo the engine's canvas.
 */
export function SelectionOutlineOverlay({
  store,
  document,
  animate,
  antialiased,
  tint,
}: {
  store: StatusStore;
  document: Document | undefined;
  animate: boolean;
  antialiased: boolean;
  /** Whether the tint fills the selection. It is off while a dialog previews on the canvas. */
  tint: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = useCanvasBacking(ref);
  const layout = useViewLayout(store);
  const selection = useSyncExternalStore(
    (listener) => document?.subscribe((change) => change !== "preview" && listener()) ?? (() => {}),
    () => document?.selection,
  );
  const polygons = useMemo(() => selection?.effectivePolygons() ?? [], [selection]);
  const path = useMemo(
    () => (layout === undefined ? undefined : outlinePath(polygons, layout)),
    [polygons, layout],
  );
  const runs = useMemo(() => {
    if (antialiased || path === undefined || layout === undefined) return undefined;
    return runsPath(outlineRuns(polygons, layout, size.width, size.height));
  }, [antialiased, path, polygons, layout, size]);
  const tick = useRef(0);
  const pattern = useRef<{ dash: number; pattern: CanvasPattern } | undefined>(undefined);
  const paint = useCallback(() => {
    const canvas = ref.current;
    if (!canvas || size.width === 0 || size.height === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (path === undefined || layout === undefined) return;
    perfMonitor?.overlayDrawn(layout);
    const time = animate ? tick.current * ANT_STEP_MS : 0;
    const offset = antOffset(time, size.scale);
    if (runs === undefined) {
      paintSelectionOutline(ctx, path, { offset, dpr: size.scale, tint });
      return;
    }
    const dash = antDash(size.scale);
    if (pattern.current?.dash !== dash) {
      const created = antPattern(ctx, dash);
      pattern.current = created === null ? undefined : { dash, pattern: created };
    }
    if (pattern.current === undefined) return;
    paintCrispOutline(ctx, runs, pattern.current.pattern, {
      offset,
      tint: tint ? path : undefined,
    });
  }, [path, layout, runs, size, animate, tint]);
  useEffect(paint, [paint]);
  useEffect(() => {
    if (!animate || path === undefined) return undefined;
    const timer = setInterval(() => {
      tick.current += 1;
      paint();
    }, ANT_STEP_MS);
    return () => clearInterval(timer);
  }, [animate, path, paint]);
  return (
    <canvas ref={ref} className="app-canvas-overlay" width={size.width} height={size.height} />
  );
}
