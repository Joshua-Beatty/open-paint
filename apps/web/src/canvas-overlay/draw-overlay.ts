import {
  BRUSH_TIP_OUTLINES,
  type BrushOutline,
  DEFAULT_BRUSH_TIP,
  type GridLines,
  type RulerOrientation,
  type RulerTick,
} from "./overlay-math";

/**
 * Draws the brush outline (TL-BRUSH-01) in the tip's shape (`BRUSH_TIP_OUTLINES`) as a dark line with
 * a light line just outside it, so the outline shows on any color.
 */
export function paintBrushOutline(ctx: CanvasRenderingContext2D, outline: BrushOutline): void {
  const tip = BRUSH_TIP_OUTLINES[outline.shape] ?? BRUSH_TIP_OUTLINES[DEFAULT_BRUSH_TIP];
  if (tip === undefined) return;
  ctx.save();
  ctx.lineWidth = 1;
  for (const [color, radius] of [
    ["#fff", outline.radius + 1],
    ["#000", outline.radius],
  ] as const) {
    ctx.strokeStyle = color;
    ctx.beginPath();
    tip.trace(ctx, outline.x, outline.y, radius);
    ctx.stroke();
  }
  ctx.restore();
}

/** A rectangle in device pixels. */
export interface DeviceRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Draws the Zoom tool's rectangle (TL-ZOOM-01): a light line with a dark dashed line on top. */
export function paintZoomRectangle(
  ctx: CanvasRenderingContext2D,
  rect: DeviceRect,
  dpr: number,
): void {
  ctx.save();
  ctx.lineWidth = dpr;
  ctx.strokeStyle = "#fff";
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  ctx.strokeStyle = "#000";
  ctx.setLineDash([4 * dpr, 4 * dpr]);
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

/** The handles of a pending Magic Wand result, in device pixels (TL-FRAME-06). */
export interface WandHandleSpots {
  readonly seed?: { readonly x: number; readonly y: number };
  readonly move?: { readonly x: number; readonly y: number };
  readonly dpr: number;
}

/** Draws the origin nub as a circle and the move handle as a square, both with a dark outline. */
export function paintWandHandles(ctx: CanvasRenderingContext2D, spots: WandHandleSpots): void {
  const { dpr } = spots;
  ctx.save();
  ctx.lineWidth = dpr;
  ctx.strokeStyle = "#000";
  ctx.fillStyle = "#fff";
  if (spots.seed !== undefined) {
    ctx.beginPath();
    ctx.arc(spots.seed.x, spots.seed.y, 4 * dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  if (spots.move !== undefined) {
    const half = 4 * dpr;
    ctx.fillRect(spots.move.x - half, spots.move.y - half, half * 2, half * 2);
    ctx.strokeRect(spots.move.x - half, spots.move.y - half, half * 2, half * 2);
  }
  ctx.restore();
}

/** The property handles of a pending shape, in device pixels (TL-SHAPE-01, TL-FRAME-06). */
export interface ShapeHandleSpots {
  readonly radius?: { readonly x: number; readonly y: number } | undefined;
  readonly tail?: { readonly x: number; readonly y: number } | undefined;
  readonly dpr: number;
}

/**
 * Draws the corner size handle of a pending shape as a circle, and the callout tail handle as a
 * diamond, both with a dark outline. The transform frame draws the shape's box.
 */
export function paintShapeHandles(ctx: CanvasRenderingContext2D, spots: ShapeHandleSpots): void {
  const { dpr } = spots;
  const half = 4 * dpr;
  ctx.save();
  ctx.lineWidth = dpr;
  ctx.strokeStyle = "#000";
  ctx.fillStyle = "#fff";
  if (spots.radius !== undefined) {
    ctx.beginPath();
    ctx.arc(spots.radius.x, spots.radius.y, half, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  if (spots.tail !== undefined) {
    const { x, y } = spots.tail;
    ctx.beginPath();
    ctx.moveTo(x, y - half);
    ctx.lineTo(x + half, y);
    ctx.lineTo(x, y + half);
    ctx.lineTo(x - half, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/** The handles of a pending line or curve, in device pixels (TL-LINE-01, TL-FRAME-06). */
export interface LineCurveHandleSpots {
  readonly start?: { readonly x: number; readonly y: number };
  readonly end?: { readonly x: number; readonly y: number };
  /** The two interior control points, for a curve. */
  readonly controls?: readonly [
    { readonly x: number; readonly y: number },
    { readonly x: number; readonly y: number },
  ];
  readonly dpr: number;
}

/**
 * Draws the control polygon of a line or curve as a dashed guide, the endpoint nubs as circles and
 * the interior control points as squares, all with a dark outline.
 */
export function paintLineCurveHandles(
  ctx: CanvasRenderingContext2D,
  spots: LineCurveHandleSpots,
): void {
  const { dpr } = spots;
  ctx.save();
  ctx.lineWidth = dpr;
  ctx.strokeStyle = "#000";
  ctx.fillStyle = "#fff";
  const polygon = [spots.start, ...(spots.controls ?? []), spots.end];
  const points = polygon.filter((point) => point !== undefined);
  if (points.length > 1 && spots.controls !== undefined) {
    ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.beginPath();
    for (const [i, point] of points.entries()) {
      if (i === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const nub of [spots.start, spots.end]) {
    if (nub === undefined) continue;
    ctx.beginPath();
    ctx.arc(nub.x, nub.y, 4 * dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  for (const control of spots.controls ?? []) {
    const half = 4 * dpr;
    ctx.fillRect(control.x - half, control.y - half, half * 2, half * 2);
    ctx.strokeRect(control.x - half, control.y - half, half * 2, half * 2);
  }
  ctx.restore();
}

/** The handles of a pending gradient, in device pixels (TL-GRAD-01, TL-FRAME-06). */
export interface GradientHandleSpots {
  readonly start?: { readonly x: number; readonly y: number };
  readonly end?: { readonly x: number; readonly y: number };
  readonly move?: { readonly x: number; readonly y: number };
  readonly dpr: number;
}

/**
 * Draws the gradient line between its nubs, the start and end nubs as circles, and the move handle
 * as a square, all with a dark outline.
 */
export function paintGradientHandles(
  ctx: CanvasRenderingContext2D,
  spots: GradientHandleSpots,
): void {
  const { dpr } = spots;
  ctx.save();
  ctx.lineWidth = dpr;
  ctx.strokeStyle = "#000";
  ctx.fillStyle = "#fff";
  if (spots.start !== undefined && spots.end !== undefined) {
    ctx.beginPath();
    ctx.moveTo(spots.start.x, spots.start.y);
    ctx.lineTo(spots.end.x, spots.end.y);
    ctx.stroke();
  }
  for (const nub of [spots.start, spots.end]) {
    if (nub === undefined) continue;
    ctx.beginPath();
    ctx.arc(nub.x, nub.y, 4 * dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  if (spots.move !== undefined) {
    const half = 4 * dpr;
    ctx.fillRect(spots.move.x - half, spots.move.y - half, half * 2, half * 2);
    ctx.strokeRect(spots.move.x - half, spots.move.y - half, half * 2, half * 2);
  }
  ctx.restore();
}

/**
 * Draws the Clone Stamp's source marker (TL-BRUSH-CS-01): a ring with a crosshair, in a light color
 * under a dark one, so it shows on any color. `x` and `y` are the source point in device pixels.
 */
export function paintCloneSource(
  ctx: CanvasRenderingContext2D,
  spot: { readonly x: number; readonly y: number; readonly dpr: number },
): void {
  const { x, y, dpr } = spot;
  const radius = 6 * dpr;
  const arm = 9 * dpr;
  ctx.save();
  for (const [color, width] of [
    ["#fff", 3 * dpr],
    ["#000", dpr],
  ] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.moveTo(x - arm, y);
    ctx.lineTo(x + arm, y);
    ctx.moveTo(x, y - arm);
    ctx.lineTo(x, y + arm);
    ctx.stroke();
  }
  ctx.restore();
}

/** The Text tool's frame in device pixels (TL-TEXT-01): the box, the caret and the move handle. */
export interface TextFrameSpots {
  readonly box?: DeviceRect;
  readonly caret?: { readonly x: number; readonly y: number; readonly height: number };
  readonly handle?: { readonly x: number; readonly y: number };
  readonly dpr: number;
}

/**
 * Draws the Text tool's box as a dashed outline, the caret as a line with a light edge, and the move
 * handle as a circle with a dark outline.
 */
export function paintTextFrame(ctx: CanvasRenderingContext2D, spots: TextFrameSpots): void {
  const { dpr } = spots;
  ctx.save();
  ctx.lineWidth = dpr;
  if (spots.box !== undefined) {
    const { x, y, width, height } = spots.box;
    ctx.strokeStyle = "#fff";
    ctx.strokeRect(x, y, width, height);
    ctx.strokeStyle = "#000";
    ctx.setLineDash([4 * dpr, 2 * dpr]);
    ctx.strokeRect(x, y, width, height);
    ctx.setLineDash([]);
  }
  if (spots.caret !== undefined) {
    const { x, y, height } = spots.caret;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 3 * dpr;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + height);
    ctx.stroke();
    ctx.strokeStyle = "#000";
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + height);
    ctx.stroke();
  }
  if (spots.handle !== undefined) {
    ctx.strokeStyle = "#000";
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(spots.handle.x, spots.handle.y, 4 * dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/** The transform frame's spots in device pixels (TL-MOVE-01, TL-FRAME-06). */
export interface TransformFrameSpots {
  readonly corners: readonly { readonly x: number; readonly y: number }[];
  /** The eight scale handles, in the order of `FRAME_HANDLES`. */
  readonly handles: readonly { readonly x: number; readonly y: number }[];
  readonly anchor: { readonly x: number; readonly y: number };
  readonly reset: { readonly x: number; readonly y: number };
  /** Whether the dashed outline is drawn; a pending shape shows only its handles. Default true. */
  readonly outline?: boolean;
  readonly dpr: number;
}

/**
 * Draws the transform frame (TL-MOVE-01): a dashed outline, square scale handles, the rotation anchor
 * as a crosshair and the anchor's reset button. Each is drawn in a light color with a dark edge, so
 * it shows on any image.
 */
export function paintTransformFrame(
  ctx: CanvasRenderingContext2D,
  spots: TransformFrameSpots,
): void {
  const { dpr } = spots;
  ctx.save();
  ctx.lineWidth = dpr;
  if (spots.outline !== false) {
    ctx.beginPath();
    spots.corners.forEach((corner, index) => {
      if (index === 0) ctx.moveTo(corner.x, corner.y);
      else ctx.lineTo(corner.x, corner.y);
    });
    ctx.closePath();
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    ctx.strokeStyle = "#000";
    ctx.setLineDash([4 * dpr, 2 * dpr]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = "#000";
  ctx.fillStyle = "#fff";
  const half = 3 * dpr;
  for (const handle of spots.handles) {
    ctx.fillRect(handle.x - half, handle.y - half, half * 2, half * 2);
    ctx.strokeRect(handle.x - half, handle.y - half, half * 2, half * 2);
  }
  const { anchor, reset } = spots;
  const arm = 6 * dpr;
  ctx.beginPath();
  ctx.moveTo(anchor.x - arm, anchor.y);
  ctx.lineTo(anchor.x + arm, anchor.y);
  ctx.moveTo(anchor.x, anchor.y - arm);
  ctx.lineTo(anchor.x, anchor.y + arm);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(anchor.x, anchor.y, 4 * dpr, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillRect(reset.x - half, reset.y - half, half * 2, half * 2);
  ctx.strokeRect(reset.x - half, reset.y - half, half * 2, half * 2);
  ctx.restore();
}

/** A one-device-pixel black and white stipple, repeated along a line (UI-VIEW-03). */
function stipple(vertical: boolean): CanvasPattern | null {
  const canvas = document.createElement("canvas");
  canvas.width = vertical ? 1 : 2;
  canvas.height = vertical ? 2 : 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = "#fff";
  if (vertical) ctx.fillRect(0, 1, 1, 1);
  else ctx.fillRect(1, 0, 1, 1);
  return ctx.createPattern(canvas, "repeat");
}

/** Draws the stippled pixel grid over the visible image at `opacity` (UI-VIEW-03). */
export function paintGrid(ctx: CanvasRenderingContext2D, lines: GridLines, opacity: number): void {
  const { left, top, right, bottom } = lines.area;
  if (right <= left || bottom <= top) return;
  ctx.save();
  ctx.globalAlpha = opacity;
  const vertical = stipple(true);
  if (vertical) {
    ctx.fillStyle = vertical;
    for (const x of lines.x) ctx.fillRect(x, top, 1, bottom - top);
  }
  const horizontal = stipple(false);
  if (horizontal) {
    ctx.fillStyle = horizontal;
    for (const y of lines.y) ctx.fillRect(left, y, right - left, 1);
  }
  ctx.restore();
}

export interface RulerColors {
  readonly background: string;
  readonly text: string;
  readonly tick: string;
  readonly selection: string;
  readonly marker: string;
}

export interface RulerPaint {
  readonly orientation: RulerOrientation;
  /** The canvas size along the ruler, in device pixels. */
  readonly length: number;
  /** The canvas size across the ruler, in device pixels. */
  readonly thickness: number;
  /** Device pixels per CSS pixel. */
  readonly dpr: number;
  readonly font: string;
  readonly colors: RulerColors;
  readonly ticks: readonly RulerTick[];
  /** The selection's extent, in device pixels along the ruler. */
  readonly selection?: { readonly start: number; readonly end: number };
  /** The pointer's position along the ruler, in device pixels. */
  readonly marker?: number;
}

/** Draws one ruler: the tinted selection band, the ticks and labels, and the cursor marker (UI-VIEW-04). */
export function paintRuler(ctx: CanvasRenderingContext2D, plan: RulerPaint): void {
  const { length, thickness, dpr, colors, ticks } = plan;
  const horizontal = plan.orientation === "horizontal";
  /** Fills a rectangle given along and across the ruler. */
  const box = (along: number, across: number, alongSize: number, acrossSize: number) => {
    if (horizontal) ctx.fillRect(along, across, alongSize, acrossSize);
    else ctx.fillRect(across, along, acrossSize, alongSize);
  };
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.fillStyle = colors.background;
  box(0, 0, length, thickness);
  if (plan.selection) {
    const start = Math.round(plan.selection.start);
    const end = Math.round(plan.selection.end);
    ctx.fillStyle = colors.selection;
    box(start, 0, end - start, thickness);
  }
  ctx.fillStyle = colors.tick;
  for (const tick of ticks) {
    const size = Math.round(thickness * (tick.major ? 0.5 : 0.2));
    box(Math.round(tick.position), thickness - size, 1, size);
  }
  ctx.font = plan.font;
  ctx.fillStyle = colors.text;
  ctx.textBaseline = "top";
  for (const tick of ticks) {
    if (tick.label === undefined) continue;
    const pad = 2 * dpr;
    if (horizontal) {
      ctx.fillText(tick.label, tick.position + pad, pad);
    } else {
      ctx.save();
      ctx.translate(pad, tick.position - pad);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(tick.label, 0, 0);
      ctx.restore();
    }
  }
  if (plan.marker !== undefined) {
    ctx.fillStyle = colors.marker;
    box(Math.round(plan.marker), 0, 1, thickness);
  }
}
