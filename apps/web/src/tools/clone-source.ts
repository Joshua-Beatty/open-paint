import {
  type Document,
  intersectRects,
  isEmptyRect,
  type Layer,
  type Rect,
  rect,
  Surface,
} from "@openpaint/document";
import { HandleStore } from "./handle-store";

/** The whole-pixel offset from a stroke's first point to its source (TL-BRUSH-CS-01). */
export interface CloneOffset {
  readonly x: number;
  readonly y: number;
}

/**
 * The anchor of the Clone Stamp (TL-BRUSH-CS-01): the point that Ctrl+click set, the layer that was
 * active then, and the offset that the first stroke after it fixed. The anchor belongs to the
 * document, not to the tool, so the offset persists across tool switches.
 */
export interface CloneAnchor {
  readonly layer: Layer;
  readonly x: number;
  readonly y: number;
  offset: CloneOffset | undefined;
}

const anchors = new WeakMap<Document, CloneAnchor>();

/** Sets the anchor of `document` to a point on `layer`, and forgets the offset of the last one. */
export function setCloneAnchor(document: Document, layer: Layer, x: number, y: number): void {
  anchors.set(document, { layer, x, y, offset: undefined });
}

/** The anchor of `document`, or undefined when none is set or its source layer was removed. */
export function cloneAnchorOf(document: Document): CloneAnchor | undefined {
  const anchor = anchors.get(document);
  if (anchor === undefined || !document.layers.includes(anchor.layer)) return undefined;
  return anchor;
}

/**
 * Where one stroke reads its source. `snapshot` is a copy of the source layer taken before the
 * stroke, and it is set only when the stroke paints on the source layer, so the stroke never copies
 * its own paint (TL-BRUSH-CS-01).
 */
export interface CloneSource {
  readonly layer: Layer;
  readonly offset: CloneOffset;
  readonly snapshot: Surface | undefined;
}

/**
 * The source pixels under `area` (in image pixels): the pixel at each point of `area` is the source
 * pixel at that point plus the offset. Source pixels off the source layer are transparent.
 */
export function readCloneSource(source: CloneSource, area: Rect): Surface {
  const out = new Surface(area.width, area.height);
  const from = rect(area.x + source.offset.x, area.y + source.offset.y, area.width, area.height);
  const hit = intersectRects(from, source.layer.pixels.bounds);
  if (isEmptyRect(hit)) return out;
  const dx = hit.x - from.x;
  const dy = hit.y - from.y;
  if (source.snapshot !== undefined) {
    out.copyFrom(source.snapshot, hit, dx, dy);
  } else {
    const pixels = source.layer.pixels.readRegion(hit);
    out.copyFrom(pixels, pixels.bounds, dx, dy);
  }
  return out;
}

/**
 * The Clone Stamp's source marker (TL-BRUSH-CS-01, SHOULD): the offset of the source from the
 * pointer, once a stroke has fixed it. The overlay draws it, and an empty state draws nothing.
 */
export const cloneSourceMarker = new HandleStore<{ readonly offset?: CloneOffset }>({});
