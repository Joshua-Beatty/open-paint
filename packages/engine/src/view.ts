import type { Rect, Size } from "@openpaint/document";

/** UI-VIEW-01: the zoom range as ratios, 1/100 to 100/1 (device pixels per image pixel). */
export const MIN_ZOOM = 1 / 100;
export const MAX_ZOOM = 100;

/** UI-VIEW-01: the 45 presets that Zoom In and Zoom Out step through, as ratios. */
export const ZOOM_PRESETS: readonly number[] = [
  1 / 100,
  1 / 88,
  1 / 76,
  1 / 64,
  1 / 56,
  1 / 48,
  1 / 40,
  1 / 32,
  1 / 28,
  1 / 24,
  1 / 20,
  1 / 16,
  1 / 14,
  1 / 12,
  1 / 10,
  1 / 8,
  1 / 6,
  1 / 5,
  1 / 4,
  1 / 3,
  1 / 2,
  2 / 3,
  1,
  3 / 2,
  2,
  3,
  4,
  5,
  6,
  8,
  10,
  12,
  14,
  16,
  20,
  24,
  28,
  32,
  40,
  48,
  56,
  64,
  76,
  88,
  100,
];

/** UI-KEY-02: each wheel notch multiplies (wheel up) or divides the zoom by this factor. */
export const WHEEL_ZOOM_FACTOR = 1.12;

/** WEB-PTR-05: one notch is 100 CSS pixels or 3 lines. */
export const NOTCH_CSS_PIXELS = 100;
const LINE_CSS_PIXELS = NOTCH_CSS_PIXELS / 3;

/**
 * The canvas view (UI-VIEW-01). Fit mode scales the image to the viewport. Fixed mode keeps a zoom
 * factor and the device-pixel offset of the image's top-left corner inside the viewport.
 * `overscroll` (UI-VIEW-02, `ui.overscroll`) lets the image scroll until any of its edges reaches the
 * viewport's centre, at any zoom. Without it the edges of a larger image never leave the viewport,
 * and a smaller image stays centred.
 */
export type ViewState =
  | { readonly mode: "fit"; readonly overscroll?: boolean }
  | {
      readonly mode: "fixed";
      readonly zoom: number;
      readonly originX: number;
      readonly originY: number;
      readonly overscroll?: boolean;
    };

export const FIT_VIEW: ViewState = { mode: "fit" };

/** The view as the UI reads it: its mode and the zoom currently in effect. */
export interface ViewStatus {
  readonly mode: "fit" | "fixed";
  readonly zoom: number;
}

/** A view resolved against a document and viewport: the zoom and the clamped origin. */
export interface ResolvedView {
  readonly zoom: number;
  readonly originX: number;
  readonly originY: number;
}

/**
 * Where the image sits in the viewport, in device pixels: the resolved zoom and origin, and the
 * image size the origin was resolved against. The status bar maps the pointer to image pixels with it.
 */
export interface ViewLayout extends ViewStatus {
  readonly originX: number;
  readonly originY: number;
  readonly documentWidth: number;
  readonly documentHeight: number;
  /** Set when the view scrolls past the image's edges (UI-VIEW-02). */
  readonly overscroll?: boolean;
}

/** A navigation command from the menus, shortcuts or the status bar. */
export type ViewCommand =
  | { readonly type: "fit" }
  | { readonly type: "actualSize" }
  | { readonly type: "zoomIn" }
  | { readonly type: "zoomOut" }
  | { readonly type: "zoom"; readonly ratio: number }
  /**
   * Zoom to Selection (UI-VIEW-01): an image rectangle, in image pixels. `maxZoom` caps the zoom
   * (the Zoom tool stops at 6400 %, TL-ZOOM-01).
   */
  | {
      readonly type: "zoomToRect";
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly maxZoom?: number;
    }
  /**
   * One preset step in or out (UI-VIEW-01), keeping the image point (`x`, `y`, in image pixels)
   * under the same place in the viewport. `maxZoom` caps a zoom-in step.
   */
  | {
      readonly type: "zoomStepAt";
      readonly direction: 1 | -1;
      readonly x: number;
      readonly y: number;
      readonly maxZoom?: number;
    }
  /**
   * One touch pinch step (WEB-PTR-03): multiplies the zoom by `ratio` around the device-pixel point
   * (`x`, `y`), then pans by (`dx`, `dy`), the midpoint's travel.
   */
  | {
      readonly type: "pinch";
      readonly ratio: number;
      readonly x: number;
      readonly y: number;
      readonly dx: number;
      readonly dy: number;
    }
  | { readonly type: "pan"; readonly dx: number; readonly dy: number }
  /** Scrolls one viewport height (up or down) or one viewport width (left or right) (UI-KEY-02). */
  | { readonly type: "page"; readonly direction: "up" | "down" | "left" | "right" }
  /** Moves the image's top-left or bottom-right corner to the matching viewport corner (UI-KEY-02). */
  | { readonly type: "edge"; readonly edge: "start" | "end" }
  /** Turns scrolling past the image's edge on or off (UI-VIEW-02, the `ui.overscroll` setting). */
  | { readonly type: "overscroll"; readonly enabled: boolean };

/** A wheel event with its position in device pixels relative to the canvas. */
export interface WheelInput {
  readonly x: number;
  readonly y: number;
  readonly deltaX: number;
  readonly deltaY: number;
  /** DOM `deltaMode`: 0 pixels, 1 lines, 2 pages. */
  readonly deltaMode: number;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** The zoom that fits the whole document into the viewport (UI-VIEW-01 "Fit to window"). */
export function fitZoom(doc: Size, viewport: Size): number {
  if (doc.width <= 0 || doc.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return 1;
  return clampZoom(Math.min(viewport.width / doc.width, viewport.height / doc.height));
}

/**
 * The range of one axis's origin in device pixels. Without overscroll the edges of a document larger
 * than the viewport never leave it. With overscroll, at any size, each edge can come in as far as
 * the viewport's centre and no further, so a corner of the image can sit in the middle of the view.
 */
export function originRange(
  documentExtent: number,
  viewportExtent: number,
  overscroll: boolean,
): { readonly lowest: number; readonly highest: number } {
  if (!overscroll) return { lowest: Math.ceil(viewportExtent - documentExtent), highest: 0 };
  const center = viewportExtent / 2;
  return { lowest: Math.ceil(center - documentExtent), highest: Math.floor(center) };
}

/** The origin of one axis that centres the document in the viewport. */
function centeredOrigin(documentExtent: number, viewportExtent: number): number {
  return Math.round((viewportExtent - documentExtent) / 2) || 0;
}

/**
 * Origin of one axis in device pixels, clamped to `originRange`. Without overscroll a document no
 * larger than the viewport is centered, since it cannot scroll.
 */
function axisOrigin(
  origin: number,
  documentExtent: number,
  viewportExtent: number,
  overscroll: boolean,
): number {
  if (!overscroll && documentExtent <= viewportExtent) {
    return centeredOrigin(documentExtent, viewportExtent);
  }
  const { lowest, highest } = originRange(documentExtent, viewportExtent, overscroll);
  return Math.min(highest, Math.max(lowest, Math.round(origin))) || 0;
}

/** The view in effect for a document and viewport, with the origin clamped to the viewport. */
export function resolveView(view: ViewState, doc: Size, viewport: Size): ResolvedView {
  const overscroll = view.overscroll === true;
  if (view.mode === "fit") {
    // Fit mode holds no offset: the image is centred, or at its top-left when even the smallest
    // zoom leaves it larger than the viewport.
    const zoom = fitZoom(doc, viewport);
    const fitOrigin = (documentExtent: number, viewportExtent: number) =>
      documentExtent <= viewportExtent
        ? centeredOrigin(documentExtent, viewportExtent)
        : axisOrigin(0, documentExtent, viewportExtent, overscroll);
    return {
      zoom,
      originX: fitOrigin(doc.width * zoom, viewport.width),
      originY: fitOrigin(doc.height * zoom, viewport.height),
    };
  }
  return {
    zoom: view.zoom,
    originX: axisOrigin(view.originX, doc.width * view.zoom, viewport.width, overscroll),
    originY: axisOrigin(view.originY, doc.height * view.zoom, viewport.height, overscroll),
  };
}

type FixedView = Extract<ViewState, { readonly mode: "fixed" }>;

/** A fixed view at `zoom` with its origin clamped, keeping the overscroll choice of `from`. */
function fixed(
  from: ViewState,
  doc: Size,
  viewport: Size,
  zoom: number,
  originX: number,
  originY: number,
): FixedView {
  const z = clampZoom(zoom);
  const overscroll = from.overscroll === true;
  return {
    mode: "fixed",
    zoom: z,
    originX: axisOrigin(originX, doc.width * z, viewport.width, overscroll),
    originY: axisOrigin(originY, doc.height * z, viewport.height, overscroll),
    ...(from.overscroll !== undefined && { overscroll: from.overscroll }),
  };
}

/** Sets the zoom so the image point under (`anchorX`, `anchorY`) stays put (UI-KEY-02). */
export function zoomAround(
  view: ViewState,
  doc: Size,
  viewport: Size,
  zoom: number,
  anchorX: number,
  anchorY: number,
): ViewState {
  const current = resolveView(view, doc, viewport);
  const next = clampZoom(zoom);
  const docX = (anchorX - current.originX) / current.zoom;
  const docY = (anchorY - current.originY) / current.zoom;
  return fixed(view, doc, viewport, next, anchorX - docX * next, anchorY - docY * next);
}

/**
 * Steps to the next larger (1) or smaller (-1) preset, anchored at the device-pixel point
 * (`anchorX`, `anchorY`). A larger step never goes above `maxZoom`.
 */
export function zoomStepAt(
  view: ViewState,
  doc: Size,
  viewport: Size,
  direction: 1 | -1,
  anchorX: number,
  anchorY: number,
  maxZoom: number = MAX_ZOOM,
): ViewState {
  const { zoom } = resolveView(view, doc, viewport);
  const target =
    direction > 0
      ? ZOOM_PRESETS.find((preset) => preset > zoom * (1 + 1e-9) && preset <= maxZoom)
      : [...ZOOM_PRESETS].reverse().find((preset) => preset < zoom * (1 - 1e-9));
  if (target === undefined) return view;
  return zoomAround(view, doc, viewport, target, anchorX, anchorY);
}

/** Steps to the next larger (1) or smaller (-1) preset, anchored at the viewport center. */
export function zoomStep(view: ViewState, doc: Size, viewport: Size, direction: 1 | -1): ViewState {
  return zoomStepAt(view, doc, viewport, direction, viewport.width / 2, viewport.height / 2);
}

/** Actual Size: 100 % (one image pixel per device pixel), anchored at the viewport center. */
export function actualSize(view: ViewState, doc: Size, viewport: Size): ViewState {
  return zoomAround(view, doc, viewport, 1, viewport.width / 2, viewport.height / 2);
}

/**
 * Zoom to Selection (UI-VIEW-01): the largest zoom that shows `area` in the viewport, with the
 * area's center at the viewport center. An empty area leaves the view unchanged. The zoom never
 * goes above `maxZoom`.
 */
export function zoomToRect(
  view: ViewState,
  doc: Size,
  viewport: Size,
  area: Rect,
  maxZoom: number = MAX_ZOOM,
): ViewState {
  if (!(area.width > 0 && area.height > 0)) return view;
  const zoom = clampZoom(
    Math.min(viewport.width / area.width, viewport.height / area.height, maxZoom),
  );
  const centerX = area.x + area.width / 2;
  const centerY = area.y + area.height / 2;
  return fixed(
    view,
    doc,
    viewport,
    zoom,
    viewport.width / 2 - centerX * zoom,
    viewport.height / 2 - centerY * zoom,
  );
}

/**
 * Whether the view can scroll (UI-KEY-02): with overscroll always, and otherwise only while the
 * image is larger than the viewport in fixed mode.
 */
export function canScroll(view: ViewState, doc: Size, viewport: Size): boolean {
  if (view.overscroll === true) return true;
  if (view.mode === "fit") return false;
  return doc.width * view.zoom > viewport.width || doc.height * view.zoom > viewport.height;
}

/**
 * Scrolls by device pixels, within the same clamp at every zoom (`originRange`). Fit mode holds no
 * offset, so a scroll that moves the image switches to fixed mode at the same zoom. Without
 * overscroll, fit mode shows the whole image and cannot scroll.
 */
export function panBy(
  view: ViewState,
  doc: Size,
  viewport: Size,
  dx: number,
  dy: number,
): ViewState {
  if (view.mode === "fit" && view.overscroll !== true) return view;
  const current = resolveView(view, doc, viewport);
  const next = fixed(view, doc, viewport, current.zoom, current.originX + dx, current.originY + dy);
  const moved = next.originX !== current.originX || next.originY !== current.originY;
  return view.mode === "fit" && !moved ? view : next;
}

/** Converts a wheel delta to CSS pixels: lines are 100/3 px, pages are one viewport tall. */
export function wheelCssPixels(
  delta: number,
  deltaMode: number,
  viewportCssHeight: number,
): number {
  if (deltaMode === 1) return delta * LINE_CSS_PIXELS;
  if (deltaMode === 2) return delta * viewportCssHeight;
  return delta;
}

/**
 * Applies a wheel event (UI-KEY-02, WEB-PTR-05). Ctrl+wheel zooms around the pointer, one notch
 * per 100 CSS pixels. Plain wheel scrolls vertically, Shift+wheel scrolls horizontally, and a
 * horizontal wheel or tilt scrolls horizontally.
 */
export function applyWheel(
  view: ViewState,
  doc: Size,
  viewport: Size,
  scale: number,
  input: WheelInput,
): ViewState {
  const cssHeight = viewport.height / scale;
  if (input.ctrlKey) {
    const notches = -wheelCssPixels(input.deltaY, input.deltaMode, cssHeight) / NOTCH_CSS_PIXELS;
    if (notches === 0) return view;
    const { zoom } = resolveView(view, doc, viewport);
    return zoomAround(view, doc, viewport, zoom * WHEEL_ZOOM_FACTOR ** notches, input.x, input.y);
  }
  const horizontal = input.shiftKey && input.deltaX === 0 ? input.deltaY : input.deltaX;
  const vertical = input.shiftKey ? 0 : input.deltaY;
  const dx = wheelCssPixels(horizontal, input.deltaMode, cssHeight) * scale;
  const dy = wheelCssPixels(vertical, input.deltaMode, cssHeight) * scale;
  return panBy(view, doc, viewport, -dx, -dy);
}

/** Applies a navigation command (UI-VIEW-01, UI-KEY-02). */
export function applyCommand(
  view: ViewState,
  doc: Size,
  viewport: Size,
  command: ViewCommand,
): ViewState {
  switch (command.type) {
    case "fit":
      return view.overscroll === undefined
        ? FIT_VIEW
        : { ...FIT_VIEW, overscroll: view.overscroll };
    case "overscroll":
      if (view.overscroll === command.enabled) return view;
      return view.mode === "fit"
        ? { ...view, overscroll: command.enabled }
        : fixed(
            { ...view, overscroll: command.enabled },
            doc,
            viewport,
            view.zoom,
            view.originX,
            view.originY,
          );
    case "actualSize":
      return actualSize(view, doc, viewport);
    case "zoomIn":
      return zoomStep(view, doc, viewport, 1);
    case "zoomOut":
      return zoomStep(view, doc, viewport, -1);
    case "zoomStepAt": {
      const { zoom, originX, originY } = resolveView(view, doc, viewport);
      return zoomStepAt(
        view,
        doc,
        viewport,
        command.direction,
        originX + command.x * zoom,
        originY + command.y * zoom,
        command.maxZoom,
      );
    }
    case "zoom":
      if (!Number.isFinite(command.ratio) || command.ratio <= 0) return view;
      return zoomAround(
        view,
        doc,
        viewport,
        command.ratio,
        viewport.width / 2,
        viewport.height / 2,
      );
    case "zoomToRect":
      return zoomToRect(view, doc, viewport, command, command.maxZoom);
    case "pinch": {
      if (!Number.isFinite(command.ratio) || command.ratio <= 0) return view;
      const { zoom } = resolveView(view, doc, viewport);
      const anchored = zoomAround(view, doc, viewport, zoom * command.ratio, command.x, command.y);
      return panBy(anchored, doc, viewport, command.dx, command.dy);
    }
    case "pan":
      return panBy(view, doc, viewport, command.dx, command.dy);
    case "page": {
      const dx =
        command.direction === "left"
          ? viewport.width
          : command.direction === "right"
            ? -viewport.width
            : 0;
      const dy =
        command.direction === "up"
          ? viewport.height
          : command.direction === "down"
            ? -viewport.height
            : 0;
      return panBy(view, doc, viewport, dx, dy);
    }
    case "edge": {
      if (view.mode === "fit" && view.overscroll !== true) return view;
      const { zoom } = resolveView(view, doc, viewport);
      const atStart = command.edge === "start";
      return fixed(
        view,
        doc,
        viewport,
        zoom,
        atStart ? 0 : viewport.width - doc.width * zoom,
        atStart ? 0 : viewport.height - doc.height * zoom,
      );
    }
  }
}

/** The status the UI shows for a view. */
export function viewStatus(view: ViewState, doc: Size, viewport: Size): ViewStatus {
  return { mode: view.mode, zoom: resolveView(view, doc, viewport).zoom };
}

/** The view state a layout stands for. Every view command reads only the resolved view. */
export function layoutState(layout: ViewLayout): ViewState {
  const overscroll = layout.overscroll === true ? { overscroll: true } : {};
  if (layout.mode === "fit") return { mode: "fit", ...overscroll };
  return {
    mode: "fixed",
    zoom: layout.zoom,
    originX: layout.originX,
    originY: layout.originY,
    ...overscroll,
  };
}

/** The view's layout in the viewport, for mapping pointer positions to image pixels. */
export function viewLayout(view: ViewState, doc: Size, viewport: Size): ViewLayout {
  const resolved = resolveView(view, doc, viewport);
  return {
    mode: view.mode,
    zoom: resolved.zoom,
    originX: resolved.originX,
    originY: resolved.originY,
    documentWidth: doc.width,
    documentHeight: doc.height,
    ...(view.overscroll === true && { overscroll: true }),
  };
}
