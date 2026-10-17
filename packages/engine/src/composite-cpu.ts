import {
  intersectRects,
  type Rect,
  rect,
  Surface,
  TILE_SIZE,
  TRANSPARENT,
} from "@openpaint/document";
import { activeLayers, type CompositeDocument, tilesCovering } from "./composite";
import { compositeRgba8 } from "./cpu";
import { applyLiveFilter, meetsLiveFilter } from "./live-filter";

/**
 * Composites `region` of the document on the CPU backend (ARC-02-03): each tile of every active
 * layer is blended bottom to top with the Rust reference kernel (DOC-BLD-02). The result is a
 * `region`-sized straight-alpha surface whose top-left pixel is the region's top-left pixel.
 */
export function compositeCpu(doc: CompositeDocument, region: Rect): Surface {
  const layers = activeLayers(doc);
  const out = new Surface(Math.max(0, region.width), Math.max(0, region.height));
  if (out.width === 0 || out.height === 0) return out;
  // Each tile blends only its part of the region, so a region smaller than a tile (a display
  // tile) costs its own pixels, not the whole tile's.
  let scratch = new Surface(0, 0);
  let over = new Surface(0, 0);
  for (const { tx, ty } of tilesCovering(region)) {
    const origin = rect(tx * TILE_SIZE, ty * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    const part = intersectRects(region, origin);
    const local = rect(part.x - origin.x, part.y - origin.y, part.width, part.height);
    const whole = part.width === TILE_SIZE && part.height === TILE_SIZE;
    if (scratch.width !== part.width || scratch.height !== part.height) {
      scratch = new Surface(part.width, part.height);
      over = new Surface(part.width, part.height);
    } else {
      scratch.fill(TRANSPARENT);
    }
    let touched = false;
    for (const layer of layers) {
      const source = layer.store.getTile(tx, ty);
      if (!source) continue;
      // A live filter adjusts a copy of the layer's pixels, never its store (FX-FW-PREVIEW-01).
      const filtered = layer.live !== undefined && meetsLiveFilter(layer.live, part);
      const copied = !whole || filtered;
      if (copied) over.copyFrom(source, local, 0, 0);
      if (filtered && layer.live) applyLiveFilter(over, layer.live, part.x, part.y, 1);
      compositeRgba8(bytesOf(scratch), bytesOf(copied ? over : source), layer.mode, layer.opacity);
      touched = true;
    }
    if (!touched) continue;
    out.copyFrom(scratch, scratch.bounds, part.x - region.x, part.y - region.y);
  }
  return out;
}

/** A `Uint8Array` view of a surface's bytes, the form the WASM kernels take. */
function bytesOf(surface: Surface): Uint8Array {
  return new Uint8Array(surface.data.buffer, surface.data.byteOffset, surface.data.byteLength);
}
