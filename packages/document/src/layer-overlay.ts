import { intersectRects, isEmptyRect, type Rect } from "./geometry";
import type { Surface } from "./surface";
import { TILE_SIZE, type TiledPixelStore } from "./tiled-store";

/** Pixels that stand in for a part of a layer, inside one store tile. */
export interface OverlayPatch {
  readonly area: Rect;
  readonly output: Surface;
}

/**
 * A pending tool result shown over a layer without changing it (TL-FRAME-01): each patch holds the
 * layer's pixels as the result would leave them over its area, so the canvas, the thumbnails and
 * the colour picker show exactly what Finish will write. The layer's own pixels stay as they are
 * until then. A new object for every change.
 */
export interface LayerOverlay {
  readonly patches: readonly OverlayPatch[];
}

/** The key of the tile at (`tx`, `ty`) of a store `tilesX` tiles wide. */
export function overlayTileKey(tx: number, ty: number, tilesX: number): number {
  return ty * tilesX + tx;
}

/** The patches of an overlay by the tile they lie in (`overlayTileKey`). */
export function overlayByTile(
  overlay: LayerOverlay | undefined,
  tilesX: number,
): Map<number, OverlayPatch[]> {
  const tiles = new Map<number, OverlayPatch[]>();
  for (const patch of overlay?.patches ?? []) {
    if (isEmptyRect(patch.area)) continue;
    const key = overlayTileKey(
      Math.floor(patch.area.x / TILE_SIZE),
      Math.floor(patch.area.y / TILE_SIZE),
      tilesX,
    );
    const list = tiles.get(key);
    if (list === undefined) tiles.set(key, [patch]);
    else list.push(patch);
  }
  return tiles;
}

/** Writes the parts of `patches` inside `area` into `out`, which holds `area`. */
export function drawOverlay(out: Surface, area: Rect, patches: readonly OverlayPatch[]): void {
  for (const patch of patches) {
    const part = intersectRects(patch.area, area);
    if (isEmptyRect(part)) continue;
    out.copyFrom(
      patch.output,
      {
        x: part.x - patch.area.x,
        y: part.y - patch.area.y,
        width: part.width,
        height: part.height,
      },
      part.x - area.x,
      part.y - area.y,
    );
  }
}

/** A store's pixels over `area` with an overlay's patches on top. */
export function readOverlaid(
  store: TiledPixelStore,
  overlay: LayerOverlay | undefined,
  area: Rect,
): Surface {
  const out = store.readRegion(area);
  if (overlay !== undefined) drawOverlay(out, area, overlay.patches);
  return out;
}
