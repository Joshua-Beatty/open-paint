import type { ColorRgba8 } from "./color";
import { intersectRects, isEmptyRect, type Rect } from "./geometry";
import type { Selection } from "./selection";
import type { Surface } from "./surface";
import type { TiledPixelStore } from "./tiled-store";

/**
 * Overwrites the selected pixels of `store` inside `area` with `color` (DOC-SEL-06d/e). Each pixel
 * moves from its current value to the color by its selection coverage (DOC-BLD-03 Overwrite), so
 * aliased selections replace pixels fully and antialiased edges blend. An empty selection covers
 * the whole area. Transparent black clears, and clearing leaves unallocated tiles unallocated.
 */
export function overwriteSelection(
  store: TiledPixelStore,
  area: Rect,
  selection: Selection,
  color: ColorRgba8,
): void {
  if (selection.isEmpty) {
    store.fill(color, area);
    return;
  }
  const target = intersectRects(area, selection.bounds());
  if (isEmptyRect(target)) return;
  const clearing = color.a === 0 && color.r === 0 && color.g === 0 && color.b === 0;
  for (const { tx, ty } of store.tilesInRect(target)) {
    if (clearing && !store.getTile(tx, ty)) continue;
    const part = intersectRects(target, store.tileBounds(tx, ty));
    const coverage = selection.mask(part);
    if (!coverage.some((weight) => weight !== 0)) continue;
    const surface = store.readRegion(part);
    overwriteWeighted(surface, color, coverage);
    store.writeRegion(surface, part.x, part.y);
  }
}

/**
 * Multiplies the alpha of every pixel in `surface` by the matching coverage byte (DOC-IMG-01).
 * Colors stay straight, so only the alpha channel changes.
 */
export function clipAlphaToCoverage(surface: Surface, coverage: Uint8Array): void {
  const data = surface.data;
  for (let i = 0; i < coverage.length; i++) {
    const weight = coverage[i] ?? 0;
    if (weight === 255) continue;
    const alpha = data[i * 4 + 3] ?? 0;
    data[i * 4 + 3] = Math.floor((alpha * weight + 127) / 255);
  }
}

function overwriteWeighted(surface: Surface, color: ColorRgba8, coverage: Uint8Array): void {
  const data = surface.data;
  const source = [color.r, color.g, color.b, color.a];
  for (let i = 0; i < coverage.length; i++) {
    const weight = coverage[i] ?? 0;
    if (weight === 0) continue;
    for (let channel = 0; channel < 4; channel++) {
      const at = i * 4 + channel;
      const dst = data[at] ?? 0;
      const src = source[channel] ?? 0;
      data[at] = Math.floor((dst * (255 - weight) + src * weight + 127) / 255);
    }
  }
}
