import type { Rect, Selection } from "@openpaint/document";

/**
 * The canvas cursors of the tools (TL-FRAME-06, TL-ZOOM-01, TL-PAN-01). CSS names the common ones.
 * The others are small inline SVGs with a hot spot and a CSS fallback, since CSS has no rotate,
 * text-placement, clone-anchor or minimal brush pointer cursor.
 */

/** A point in canvas pixels. */
interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * The radius of a handle's hit area in CSS pixels (TL-FRAME-06). It is measured on screen, as the
 * click dead zone is, so a handle is as easy to grab at any zoom. Nubs are drawn 4 CSS px wide, and
 * a press that stays inside the 4 CSS px dead zone stays on the handle it hit.
 */
export const HANDLE_HIT_CSS_PX = 6;

/** The view's zoom of a sample, in CSS pixels per canvas pixel. Samples without one count as 100 %. */
export function viewScaleOf(sample: { readonly viewScale?: number } | undefined): number {
  const scale = sample?.viewScale;
  return scale !== undefined && Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** The handle hit radius in canvas pixels at the sample's zoom. */
export function handleHitRadius(sample: { readonly viewScale?: number } | undefined): number {
  return HANDLE_HIT_CSS_PX / viewScaleOf(sample);
}

/** Whether a sample lies on a handle at `point`, measured in CSS pixels. */
export function nearHandle(sample: Point & { readonly viewScale?: number }, point: Point): boolean {
  return Math.hypot(sample.x - point.x, sample.y - point.y) <= handleHitRadius(sample);
}

const boundsCache = new WeakMap<Selection, Rect>();

/** A selection's bounds, computed once per selection, since a hover asks for them on every move. */
export function selectionBounds(selection: Selection): Rect {
  let bounds = boundsCache.get(selection);
  if (bounds === undefined) {
    bounds = selection.bounds();
    boundsCache.set(selection, bounds);
  }
  return bounds;
}

/** Draws `d` black on a white halo, so the glyph shows on any background. */
function outlined(d: string, width = 1.5): string {
  return (
    `<path d='${d}' fill='none' stroke='white' stroke-width='${width + 2}' stroke-linecap='round' stroke-linejoin='round'/>` +
    `<path d='${d}' fill='none' stroke='black' stroke-width='${width}' stroke-linecap='round' stroke-linejoin='round'/>`
  );
}

/** A CSS cursor from an SVG body on a 24 x 24 canvas, with its hot spot and a CSS fallback. */
export function svgCursor(body: string, hotX: number, hotY: number, fallback: string): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotX} ${hotY}, ${fallback}`;
}

/** Selection tools, the Magic Wand, the Paint Bucket, the Pencil and the drawing tools. */
export const CROSSHAIR_CURSOR = "crosshair";

/** Over something a drag moves: a selection with a move tool, or a move handle. */
export const MOVE_CURSOR = "move";

/** Over a handle that a drag picks up (TL-FRAME-06), and while it is dragged. */
export const GRAB_CURSOR = "grab";
export const GRABBING_CURSOR = "grabbing";

/** Over a button on the canvas, such as the rotation anchor's reset button. */
export const BUTTON_CURSOR = "pointer";

/** Over the text box being edited (TL-TEXT-01). */
export const TEXT_EDIT_CURSOR = "text";

/** The crosshair lines around a centre at (11, 11), with a gap where the pixel is. */
const CROSSHAIR_LINES = "M11 2v6M11 14v6M2 11h6M14 11h6";

/**
 * The brush tools' pointer (TL-BRUSH-01): a small dot at the centre of the brush outline, which the
 * overlay draws at the brush size.
 */
export const BRUSH_POINTER_CURSOR = svgCursor(
  "<circle cx='11' cy='11' r='1.5' fill='black' stroke='white' stroke-width='1'/>",
  11,
  11,
  "crosshair",
);

/** The Clone Stamp's anchor cursor while Ctrl is held (TL-BRUSH-CS-01): a target. */
export const CLONE_ANCHOR_CURSOR = svgCursor(
  outlined("M11 1v6M11 15v6M1 11h6M15 11h6") +
    "<circle cx='11' cy='11' r='6' fill='none' stroke='white' stroke-width='3.25'/>" +
    "<circle cx='11' cy='11' r='6' fill='none' stroke='black' stroke-width='1.25'/>",
  11,
  11,
  "crosshair",
);

/**
 * The Text tool away from the box being edited: a corner mark where the text's top left lands,
 * with an I-beam beside it (TL-TEXT-01).
 */
export const TEXT_PLACE_CURSOR = svgCursor(
  outlined("M3 9V3h6") + outlined("M12 6h6M15 6v13M12 19h6"),
  3,
  3,
  "text",
);

/** The pipette badge of the Color Picker's cursors. */
const PIPETTE = outlined("M14.5 22.5l5.5-5.5", 1.75) + outlined("M18.5 15.5l3 3", 2.5);

/** The Color Picker sampling the layer (TL-PICK-01): a crosshair with a pipette. */
export const PICK_LAYER_CURSOR = svgCursor(
  outlined(CROSSHAIR_LINES) + PIPETTE,
  11,
  11,
  "crosshair",
);

/** The Color Picker sampling the image: the pipette with a stack of layers. */
export const PICK_IMAGE_CURSOR = svgCursor(
  outlined(CROSSHAIR_LINES) +
    PIPETTE +
    "<rect x='15.5' y='1.5' width='5' height='5' fill='white' stroke='black'/>" +
    "<rect x='17.5' y='3.5' width='5' height='5' fill='white' stroke='black'/>",
  11,
  11,
  "crosshair",
);

/** The directional resize cursors, by the handle's direction in 45° steps from the x axis. */
const RESIZE_CURSORS = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"] as const;

export type ResizeCursor = (typeof RESIZE_CURSORS)[number];

/**
 * The resize cursor for a handle that moves along (`dx`, `dy`) in canvas pixels (y down), rounded
 * to the nearest of the four CSS directions, so a rotated frame shows the handle's true direction.
 */
export function resizeCursor(dx: number, dy: number): ResizeCursor {
  const degrees = (Math.atan2(dy, dx) * 180) / Math.PI;
  const step = Math.round((((degrees % 180) + 180) % 180) / 45) % 4;
  return RESIZE_CURSORS[step] ?? "ew-resize";
}

/** The rotate cursors are made for this many directions. */
const ROTATE_STEPS = 24;

const rotateCursors = new Map<number, string>();

/**
 * The rotate cursor (TL-MOVE-01 rotate box): a curved double arrow that bulges away from the
 * frame, towards (`dx`, `dy`) from its pivot, so it faces the corner or edge under the pointer.
 */
export function rotateCursor(dx: number, dy: number): string {
  const angle = dx === 0 && dy === 0 ? -Math.PI / 4 : Math.atan2(dy, dx);
  const step =
    ((Math.round((angle / (2 * Math.PI)) * ROTATE_STEPS) % ROTATE_STEPS) + ROTATE_STEPS) %
    ROTATE_STEPS;
  let cursor = rotateCursors.get(step);
  if (cursor === undefined) {
    const degrees = (step * 360) / ROTATE_STEPS;
    // An arc around (4, 12) that bulges to the right, with an arrowhead at each end.
    const glyph =
      outlined("M9.8 5.1A9 9 0 0 1 9.8 18.9") +
      "<path d='M8.3 20.2L12.6 19.9L9.4 16Z M8.3 3.8L12.6 4.1L9.4 8Z' fill='black' stroke='white' stroke-width='0.75' stroke-linejoin='round'/>";
    cursor = svgCursor(`<g transform='rotate(${degrees} 12 12)'>${glyph}</g>`, 12, 12, "alias");
    rotateCursors.set(step, cursor);
  }
  return cursor;
}
