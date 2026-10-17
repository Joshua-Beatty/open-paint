import { type MessageId, t } from "@openpaint/i18n";
import { type FloatingContent, placeByCoverage } from "./coverage-place";
import { intersectRects, isEmptyRect, type Point, type Rect, rect, type Size } from "./geometry";
import { Selection } from "./selection";
import {
  IDENTITY_AFFINE,
  rectPolygon,
  type SelectionPolygon,
  type SelectionQuality,
  transformPolygon,
} from "./selection-polygons";
import type { Surface } from "./surface";
import type { TiledPixelStore } from "./tiled-store";

/** A copied or pasted bitmap and the selection outline it came from (DOC-CLP-02). */
export interface ClipboardImage {
  /** Straight-alpha RGBA8 covering the copied bounds. Pixels outside the selection are transparent. */
  readonly pixels: Surface;
  /** Where the bitmap sat on the canvas it was copied from. Undefined for images from outside. */
  readonly origin?: Point;
  /** The selection outline in bitmap coordinates. Undefined when the copy had no selection. */
  readonly outline?: readonly SelectionPolygon[];
}

/** Options for a paste (DOC-CLP-01f, DOC-CLP-05). */
export interface PasteOptions {
  /** Pastes into a new layer above the active one. */
  readonly newLayer?: boolean;
  /** Grows the canvas to this size first, anchored top-left with transparent fill. */
  readonly expandTo?: Size;
}

/** Where a paste lands, and whether the view must scroll to show it (DOC-CLP-05). */
export interface PastePosition extends Point {
  /** True when the pasted image does not overlap the visible part of the canvas. */
  readonly reveal: boolean;
}

/** A clipboard operation that failed. `messageId` is the user-facing message (DOC-CLP-01). */
export class ClipboardError extends Error {
  override readonly name = "ClipboardError";

  constructor(readonly messageId: MessageId) {
    super(t(messageId));
  }
}

/**
 * The outline as JSON (DOC-CLP-03): `{"polygonList": ["x,y,x,y,...", ...]}`. Numbers are written
 * with their shortest round-trip form.
 */
export function formatSelectionOutline(polygons: readonly SelectionPolygon[]): string {
  return JSON.stringify({
    polygonList: polygons.map((polygon) => polygon.map((value) => String(value)).join(",")),
  });
}

/**
 * Reads an outline written by `formatSelectionOutline`. Returns undefined for anything else: bad
 * JSON, a missing list, an odd coordinate count, or a value that is not a finite number.
 */
export function parseSelectionOutline(text: string): readonly SelectionPolygon[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || !("polygonList" in value)) return undefined;
  const list = value.polygonList;
  if (!Array.isArray(list)) return undefined;
  const polygons: SelectionPolygon[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") return undefined;
    const parts = entry.split(",");
    if (parts.length % 2 !== 0) return undefined;
    const numbers = parts.map((part) => (part.trim() === "" ? Number.NaN : Number(part)));
    if (!numbers.every((value) => Number.isFinite(value))) return undefined;
    polygons.push(numbers);
  }
  return polygons;
}

/** Moves polygons by (`dx`, `dy`). */
export function translatePolygons(
  polygons: readonly SelectionPolygon[],
  dx: number,
  dy: number,
): SelectionPolygon[] {
  const m = { ...IDENTITY_AFFINE, e: dx, f: dy };
  return polygons.map((polygon) => transformPolygon(polygon, m));
}

/** The outline in bitmap coordinates, or the bitmap's bounds when the copy had no selection. */
export function imageOutline(image: ClipboardImage): readonly SelectionPolygon[] {
  return image.outline ?? [rectPolygon(rect(0, 0, image.pixels.width, image.pixels.height))];
}

/** The image's outline on the canvas it was copied from (DOC-CLP-01h "mask or bounds"). */
export function canvasOutline(image: ClipboardImage): readonly SelectionPolygon[] {
  return translatePolygons(imageOutline(image), image.origin?.x ?? 0, image.origin?.y ?? 0);
}

/** DOC-CLP-05: true when the pasted image is larger than the canvas in either dimension. */
export function pasteExceedsCanvas(canvas: Size, image: Size): boolean {
  return image.width > canvas.width || image.height > canvas.height;
}

/** DOC-CLP-05 "Expand canvas": the larger of the two sizes in each dimension. */
export function expandedCanvasSize(canvas: Size, image: Size): Size {
  return {
    width: Math.max(canvas.width, image.width),
    height: Math.max(canvas.height, image.height),
  };
}

/**
 * DOC-CLP-05 placement. The image goes back to its original location when that overlaps the
 * visible part of the canvas. Otherwise it goes to the visible part's top-left. Either way it is
 * clamped so it stays as visible as possible. `visible` is in canvas coordinates.
 */
export function pastePosition(
  canvas: Size,
  image: Size,
  visible: Rect,
  origin?: Point,
): PastePosition {
  const view = intersectRects(visible, rect(0, 0, canvas.width, canvas.height));
  const hasView = !isEmptyRect(view);
  const placed = (at: Point) => rect(at.x, at.y, image.width, image.height);
  const original =
    origin && hasView && !isEmptyRect(intersectRects(placed(origin), view)) ? origin : undefined;
  const preferred = original ?? { x: hasView ? view.x : 0, y: hasView ? view.y : 0 };
  const x = clampAxis(preferred.x, canvas.width, image.width);
  const y = clampAxis(preferred.y, canvas.height, image.height);
  return { x, y, reveal: !hasView || isEmptyRect(intersectRects(placed({ x, y }), view)) };
}

/** The part of the canvas that a paste of `size` at `at` covers. */
export function pasteArea(size: Size, at: Point, bounds: Rect): Rect {
  return intersectRects(rect(at.x, at.y, size.width, size.height), bounds);
}

/**
 * The pasted image as floating content (DOC-CLP-05, TL-MOVE-PIX-01): its pixels, and its outline's
 * coverage in the image's own pixels, with `quality`. An image with no outline is covered in full.
 * Copy clipped the alpha of the outline's antialiased edge to its coverage, so the content takes
 * that clip back off: placing it by coverage then gives the edge the copied alpha again, and over
 * opaque pixels it blends as the edge of a lifted selection does.
 */
export function pasteContent(image: ClipboardImage, quality: SelectionQuality): FloatingContent {
  if (image.outline === undefined) return { pixels: image.pixels };
  const coverage = new Selection(image.outline, quality).mask(image.pixels.bounds);
  const pixels = image.pixels.clone();
  const data = pixels.data;
  for (let i = 0; i < coverage.length; i++) {
    const c = coverage[i] ?? 0;
    if (c === 0 || c === 255) continue;
    const alpha = data[i * 4 + 3] ?? 0;
    data[i * 4 + 3] = Math.min(255, Math.round((alpha * 255) / c));
  }
  return { pixels, coverage };
}

/**
 * Places pasted `content` on `store` with its top-left at `at`, clipped to the store. Inside the
 * content's coverage the pasted pixels replace the target's, transparency included, as Move
 * Selected Pixels places them (`placeByCoverage`).
 */
export function pasteReplace(store: TiledPixelStore, content: FloatingContent, at: Point): void {
  const area = pasteArea(content.pixels, at, store.bounds);
  if (isEmptyRect(area)) return;
  const dst = store.readRegion(area);
  placeByCoverage(dst, content.pixels, at.x - area.x, at.y - area.y, content.coverage);
  store.writeRegion(dst, area.x, area.y);
}

function clampAxis(value: number, canvas: number, image: number): number {
  const slack = canvas - image;
  return Math.min(Math.max(value, Math.min(0, slack)), Math.max(0, slack));
}
