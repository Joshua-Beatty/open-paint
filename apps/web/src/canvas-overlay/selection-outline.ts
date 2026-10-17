import type { SelectionPolygon } from "@openpaint/document";

/** DOC-SEL-04 (proposed): 4 px black and 4 px white dashes, advancing 1 px every 50 ms. */
export const ANT_DASH_PX = 4;
export const ANT_STEP_MS = 50;
/** DOC-SEL-04 (proposed): a translucent blue tint, about 15 % opaque, inside the selection. */
export const SELECTION_TINT = "rgba(31, 111, 235, 0.15)";

/** The dialogs open over the canvas that decide whether the selection tint shows. */
export interface TintDialogs {
  /** The Layer Properties dialog, which previews its changes live (DOC-LYR-02). */
  readonly layerProperties: boolean;
  /** The phase of the effect or adjustment run, or undefined when none is showing. */
  readonly effect: "dialog" | "rendering" | "error" | undefined;
}

/**
 * Whether the selection tint shows (DOC-SEL-04). It is off while a dialog previews its result on
 * the canvas, so the tint does not change the colors being judged: the Layer Properties dialog
 * (DOC-LYR-02) and an effect or adjustment dialog with its live preview (FX-FW-PREVIEW-01,
 * ADJ-COMMON-02), until its result is committed.
 */
export function selectionTintShown(dialogs: TintDialogs): boolean {
  return !dialogs.layerProperties && dialogs.effect !== "dialog" && dialogs.effect !== "rendering";
}

/** Where the image sits in the canvas, in device pixels (the engine's view layout). */
export interface OutlineLayout {
  readonly zoom: number;
  readonly originX: number;
  readonly originY: number;
}

/**
 * The selection polygons as one path in device pixels. Each polygon is a flat `x, y` list in image
 * pixels. Pixel-aligned edges land half a device pixel inside so 1 px lines stay sharp.
 */
export function outlinePath(
  polygons: readonly SelectionPolygon[],
  layout: OutlineLayout,
): Path2D | undefined {
  if (polygons.length === 0) return undefined;
  const path = new Path2D();
  const at = (value: number, origin: number) => Math.round(origin + value * layout.zoom) + 0.5;
  for (const polygon of polygons) {
    if (polygon.length < 6) continue;
    path.moveTo(at(polygon[0] ?? 0, layout.originX), at(polygon[1] ?? 0, layout.originY));
    for (let i = 2; i + 1 < polygon.length; i += 2) {
      path.lineTo(at(polygon[i] ?? 0, layout.originX), at(polygon[i + 1] ?? 0, layout.originY));
    }
    path.closePath();
  }
  return path;
}

/**
 * The selection edges as one-device-pixel runs `x, y, width, height`, without antialiasing (the
 * "Antialiased selection outline" setting off, DOC-SEL-04). Each edge is traced pixel by pixel
 * from the same device pixels as `outlinePath`, and the pixels in one row (or column) merge into
 * one run, so filling the runs draws a crisp line. Edges are clipped to the `width` × `height`
 * canvas first, so the work follows the visible outline, not the zoomed one.
 */
export function outlineRuns(
  polygons: readonly SelectionPolygon[],
  layout: OutlineLayout,
  width: number,
  height: number,
): number[] {
  const runs: number[] = [];
  const at = (value: number, origin: number) => Math.round(origin + value * layout.zoom);
  for (const polygon of polygons) {
    if (polygon.length < 6) continue;
    const count = Math.floor(polygon.length / 2);
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % count;
      const segment = clipSegment(
        at(polygon[i * 2] ?? 0, layout.originX),
        at(polygon[i * 2 + 1] ?? 0, layout.originY),
        at(polygon[j * 2] ?? 0, layout.originX),
        at(polygon[j * 2 + 1] ?? 0, layout.originY),
        width,
        height,
      );
      if (segment !== undefined) traceSegment(...segment, runs);
    }
  }
  return runs;
}

/**
 * The part of the segment inside the canvas grown by a pixel (Liang-Barsky), with whole-pixel
 * ends, or undefined when none of it is. A segment inside the canvas is returned unchanged.
 */
function clipSegment(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  height: number,
): [number, number, number, number] | undefined {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, x0 + 1],
    [dx, width - x0],
    [-dy, y0 + 1],
    [dy, height - y0],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return undefined;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return undefined;
  }
  if (t0 === 0 && t1 === 1) return [x0, y0, x1, y1];
  return [
    Math.round(x0 + dx * t0),
    Math.round(y0 + dy * t0),
    Math.round(x0 + dx * t1),
    Math.round(y0 + dy * t1),
  ];
}

/** Appends the pixels of the line from (x0, y0) to (x1, y1), both included, as runs. */
function traceSegment(x0: number, y0: number, x1: number, y1: number, runs: number[]): void {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  const horizontal = dx >= dy;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  let startX = x;
  let startY = y;
  const emit = () => {
    runs.push(
      Math.min(startX, x),
      Math.min(startY, y),
      Math.abs(x - startX) + 1,
      Math.abs(y - startY) + 1,
    );
  };
  while (x !== x1 || y !== y1) {
    const doubled = 2 * err;
    let nx = x;
    let ny = y;
    if (doubled > -dy) {
      err -= dy;
      nx += sx;
    }
    if (doubled < dx) {
      err += dx;
      ny += sy;
    }
    if (horizontal ? ny !== y : nx !== x) {
      emit();
      startX = nx;
      startY = ny;
    }
    x = nx;
    y = ny;
  }
  emit();
}

/** The length of one ant dash in whole device pixels. */
export function antDash(dpr: number): number {
  return Math.max(1, Math.round(ANT_DASH_PX * dpr));
}

/**
 * The tile of the crisp ants: diagonal black and white stripes `dash` pixels wide, RGBA. Filling
 * one-pixel runs with it repeated gives `dash` black then `dash` white pixels along any row or
 * column, and shifting it marches them.
 */
export function antTile(dash: number): Uint8ClampedArray<ArrayBuffer> {
  const size = dash * 2;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const value = (x + y) % size < dash ? 0 : 255;
      data.set([value, value, value, 255], (y * size + x) * 4);
    }
  }
  return data;
}

/**
 * Draws the crisp selection outline: the tint inside it when given, then the runs filled with
 * the ant `pattern` (from `antTile`), shifted by the whole-pixel ant offset. One fill draws every
 * ant, so a step of the animation costs one fill of the cached runs.
 */
export function paintCrispOutline(
  ctx: CanvasRenderingContext2D,
  runs: Path2D,
  pattern: CanvasPattern,
  options: { readonly offset: number; readonly tint: Path2D | undefined },
): void {
  ctx.save();
  if (options.tint !== undefined) {
    ctx.fillStyle = SELECTION_TINT;
    ctx.fill(options.tint, "evenodd");
  }
  ctx.imageSmoothingEnabled = false;
  pattern.setTransform({ e: -Math.round(options.offset), f: 0 });
  ctx.fillStyle = pattern;
  ctx.fill(runs);
  ctx.restore();
}

/** The dash offset of the ants at `time` ms: one pixel per step, wrapping each black/white period. */
export function antOffset(time: number, dpr: number): number {
  const period = ANT_DASH_PX * 2 * dpr;
  return -((Math.floor(time / ANT_STEP_MS) * dpr) % period);
}

/**
 * Draws the selection (DOC-SEL-04): the tint inside it (even-odd, as the selection mask fills it),
 * then the marching ants along its edges as black dashes over white ones.
 */
export function paintSelectionOutline(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  options: { readonly offset: number; readonly dpr: number; readonly tint: boolean },
): void {
  ctx.save();
  if (options.tint) {
    ctx.fillStyle = SELECTION_TINT;
    ctx.fill(path, "evenodd");
  }
  ctx.lineWidth = options.dpr;
  ctx.strokeStyle = "#fff";
  ctx.setLineDash([]);
  ctx.stroke(path);
  ctx.strokeStyle = "#000";
  ctx.setLineDash([ANT_DASH_PX * options.dpr, ANT_DASH_PX * options.dpr]);
  ctx.lineDashOffset = options.offset;
  ctx.stroke(path);
  ctx.restore();
}
