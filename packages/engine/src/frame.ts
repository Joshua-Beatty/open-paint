import { type Rect, rectFromEdges, type Size } from "@openpaint/document";
import {
  DISPLAY_TILE_SIZE,
  type DisplayTile,
  displayLevels,
  mipLevel,
  type Sampling,
  samplingFor,
  type TileRef,
  tileEdge,
  tilesAcross,
} from "./display-tiles";
import { resolveView, type ViewState } from "./view";

/** Red, green and blue, each 0-255. */
export type Rgb = readonly [number, number, number];

/** Colors and fixed geometry of the canvas chrome (UI-VIEW-02), in the theme's terms. */
export interface CanvasTheme {
  /** The area around the canvas. */
  readonly background: Rgb;
  /** The drop shadow color and opacity (0-1). */
  readonly shadow: { readonly color: Rgb; readonly alpha: number };
  /** Transparency checkerboard brightness, 0-1. Light squares are 255 and dark 191 before it. */
  readonly checkerBrightness: number;
  /** A custom border color, drawn one device pixel outside the image. Off when undefined. */
  readonly border?: Rgb;
}

export const DEFAULT_CANVAS_THEME: CanvasTheme = {
  background: [60, 60, 60],
  shadow: { color: [0, 0, 0], alpha: 0.5 },
  checkerBrightness: 1,
};

/** The canvas chrome settings (SET-DLG-04), in the engine's terms. */
export interface CanvasStyle {
  /** Whether the image casts a drop shadow (`canvas.dropShadow`). */
  readonly dropShadow: boolean;
  /** Transparency checkerboard brightness, 0.25 to 1 (`canvas.checkerboardBrightness`). */
  readonly checkerboardBrightness: number;
  /** The color of the area outside the image, or null for none (`canvas.customBorderColor`). */
  readonly borderColor: Rgb | null;
}

/** The chrome theme for a set of canvas settings. */
export function canvasTheme(style: CanvasStyle): CanvasTheme {
  return {
    background: DEFAULT_CANVAS_THEME.background,
    shadow: {
      color: DEFAULT_CANVAS_THEME.shadow.color,
      alpha: style.dropShadow ? DEFAULT_CANVAS_THEME.shadow.alpha : 0,
    },
    checkerBrightness: style.checkerboardBrightness,
    ...(style.borderColor && { border: style.borderColor }),
  };
}

/** Checkerboard, shadow and border geometry in device pixels for one frame. */
export interface FrameStyle {
  readonly background: Rgb;
  readonly checker: { readonly size: number; readonly light: number; readonly dark: number };
  readonly shadow: { readonly color: Rgb; readonly alpha: number; readonly sigma: number };
  readonly border?: Rgb;
}

/** A display tile drawn into the viewport. The source is a rectangle in the tile's pixels. */
export interface TileDraw {
  readonly tile: DisplayTile;
  readonly sampling: Sampling;
  readonly src: Rect;
  readonly dst: Rect;
}

/** Everything a presenter needs to draw one frame. */
export interface FramePlan {
  readonly width: number;
  readonly height: number;
  readonly zoom: number;
  /** The image's on-screen rectangle in device pixels. */
  readonly canvas: Rect;
  readonly style: FrameStyle;
  /** Draw order: background first. A coarser tile is drawn where its finer tile is missing. */
  readonly tiles: TileDraw[];
  /** Visible tiles that are missing or stale, in priority order. */
  readonly wanted: TileRef[];
}

export interface FrameInput {
  readonly view: ViewState;
  readonly doc: Size;
  readonly viewport: Size;
  /** Device pixels per CSS pixel (`devicePixelRatio`). */
  readonly scale: number;
  readonly theme: CanvasTheme;
  readonly lookup: (level: number, tx: number, ty: number) => DisplayTile | undefined;
  /** Whether a cached tile is out of date. It is still drawn, and also requested for a rebuild. */
  readonly stale?: (level: number, tx: number, ty: number) => boolean;
}

/**
 * UI scale for chrome metrics: the device pixel ratio rounded down to a power of two, minimum 1
 * (UI-VIEW-02).
 */
export function uiScale(scale: number): number {
  return Math.max(1, 2 ** Math.floor(Math.log2(scale > 0 ? scale : 1)));
}

/** Checkerboard, shadow and border metrics for a device pixel ratio. */
export function frameStyle(theme: CanvasTheme, scale: number): FrameStyle {
  const ui = uiScale(scale);
  return {
    background: theme.background,
    checker: {
      size: 4 * ui,
      light: 255 * theme.checkerBrightness,
      dark: 191 * theme.checkerBrightness,
    },
    shadow: { ...theme.shadow, sigma: 4 * ui },
    ...(theme.border && { border: theme.border }),
  };
}

/** Plans one frame: the image rectangle, the mip level and the tiles that cover the viewport. */
export function planFrame(input: FrameInput): FramePlan {
  const { doc, viewport } = input;
  const { zoom, originX, originY } = resolveView(input.view, doc, viewport);
  const canvas = rectFromEdges(
    originX,
    originY,
    Math.round(originX + doc.width * zoom),
    Math.round(originY + doc.height * zoom),
  );
  const levels = displayLevels(doc.width, doc.height);
  const level = mipLevel(zoom, levels);
  const sampling = samplingFor(level, zoom);
  const edge = tileEdge(level);
  const tiles: TileDraw[] = [];
  const wanted: TileRef[] = [];

  const visibleX0 = Math.max(0, -originX / zoom);
  const visibleX1 = Math.min(doc.width, (viewport.width - originX) / zoom);
  const visibleY0 = Math.max(0, -originY / zoom);
  const visibleY1 = Math.min(doc.height, (viewport.height - originY) / zoom);
  if (visibleX1 > visibleX0 && visibleY1 > visibleY0) {
    const across = tilesAcross(doc.width, level);
    const down = tilesAcross(doc.height, level);
    const tx1 = Math.min(across - 1, Math.ceil(visibleX1 / edge) - 1);
    const ty1 = Math.min(down - 1, Math.ceil(visibleY1 / edge) - 1);
    for (let ty = Math.max(0, Math.floor(visibleY0 / edge)); ty <= ty1; ty++) {
      for (let tx = Math.max(0, Math.floor(visibleX0 / edge)); tx <= tx1; tx++) {
        const dst = tileRect(originX, originY, zoom, edge, tx, ty, canvas);
        if (dst.width <= 0 || dst.height <= 0) continue;
        const cover = imageCover(doc, edge, tx, ty);
        const own = input.lookup(level, tx, ty);
        if (own) {
          tiles.push({ tile: own, sampling, src: partOf(fullTile(), cover), dst });
          if (input.stale?.(level, tx, ty)) wanted.push({ level, tx, ty });
          continue;
        }
        wanted.push({ level, tx, ty });
        const coarser = coarserCover(input.lookup, levels, level, tx, ty);
        if (coarser) tiles.push({ ...coarser, src: partOf(coarser.src, cover), dst });
      }
    }
  }

  return {
    width: viewport.width,
    height: viewport.height,
    zoom,
    canvas,
    style: frameStyle(input.theme, input.scale),
    tiles,
    wanted,
  };
}

function fullTile(): Rect {
  return rectFromEdges(0, 0, DISPLAY_TILE_SIZE, DISPLAY_TILE_SIZE);
}

/**
 * Device-pixel rectangle of a tile; neighbours share edges, so no seams open between them. A tile
 * that holds the image's right or bottom edge ends at the canvas rectangle's edge, so the image
 * covers the checkerboard exactly, whatever the rounding.
 */
function tileRect(
  originX: number,
  originY: number,
  zoom: number,
  edge: number,
  tx: number,
  ty: number,
  canvas: Rect,
): Rect {
  return rectFromEdges(
    Math.round(originX + tx * edge * zoom),
    Math.round(originY + ty * edge * zoom),
    Math.min(canvas.x + canvas.width, Math.round(originX + (tx + 1) * edge * zoom)),
    Math.min(canvas.y + canvas.height, Math.round(originY + (ty + 1) * edge * zoom)),
  );
}

/** The share of a tile, across and down, that the image covers: 1 except at its right and bottom. */
function imageCover(doc: Size, edge: number, tx: number, ty: number): { x: number; y: number } {
  return {
    x: Math.min(1, (doc.width - tx * edge) / edge),
    y: Math.min(1, (doc.height - ty * edge) / edge),
  };
}

/** The top-left part of `src` that the image covers. */
function partOf(src: Rect, cover: { x: number; y: number }): Rect {
  return { x: src.x, y: src.y, width: src.width * cover.x, height: src.height * cover.y };
}

/**
 * The nearest cached coarser tile covering a missing tile, with the part of it that the missing
 * tile occupies as its source rectangle (ARC-03-06: coarser mips show underneath).
 */
function coarserCover(
  lookup: FrameInput["lookup"],
  levels: number,
  level: number,
  tx: number,
  ty: number,
): { tile: DisplayTile; sampling: Sampling; src: Rect } | undefined {
  for (let coarse = level + 1; coarse < levels; coarse++) {
    const factor = 2 ** (coarse - level);
    const ax = Math.floor(tx / factor);
    const ay = Math.floor(ty / factor);
    const tile = lookup(coarse, ax, ay);
    if (!tile) continue;
    const size = DISPLAY_TILE_SIZE / factor;
    const x = (tx - ax * factor) * size;
    const y = (ty - ay * factor) * size;
    return { tile, sampling: "bilinear", src: rectFromEdges(x, y, x + size, y + size) };
  }
  return undefined;
}
