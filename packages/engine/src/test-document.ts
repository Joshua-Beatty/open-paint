import { rect, Surface, TILE_SIZE, TiledPixelStore } from "@openpaint/document";
import type { CompositeDocument } from "./composite";

/**
 * Writes the pattern for the `w` x `h` block at (`originX`, `originY`) of a `width` x `height`
 * image into `tile`. The pattern is a red and green ramp, a 64 px blue checker, and a transparent
 * ring around the center. The ring shows the canvas checkerboard through the image.
 */
function fillPattern(
  tile: Surface,
  originX: number,
  originY: number,
  w: number,
  h: number,
  width: number,
  height: number,
): void {
  const data = tile.data;
  const spanX = Math.max(1, width - 1);
  const spanY = Math.max(1, height - 1);
  for (let y = 0; y < h; y++) {
    const gy = originY + y;
    const green = Math.round((gy * 255) / spanY);
    const cy = (gy - height / 2) / height;
    for (let x = 0; x < w; x++) {
      const gx = originX + x;
      const cx = (gx - width / 2) / width;
      const ring = cx * cx + cy * cy;
      const i = (y * TILE_SIZE + x) * 4;
      data[i] = Math.round((gx * 255) / spanX);
      data[i + 1] = green;
      data[i + 2] = ((gx >> 6) + (gy >> 6)) % 2 === 0 ? 255 : 64;
      data[i + 3] = ring > 0.09 && ring < 0.16 ? 0 : 255;
    }
  }
}

/**
 * A generated test document (M0.09): one layer with a color ramp, a checker and a transparent ring,
 * used to exercise the canvas view at large sizes until documents can be opened and edited.
 */
export function createTestDocument(width: number, height: number): CompositeDocument {
  const store = new TiledPixelStore(width, height);
  for (let ty = 0; ty < store.tilesY; ty++) {
    for (let tx = 0; tx < store.tilesX; tx++) {
      const originX = tx * TILE_SIZE;
      const originY = ty * TILE_SIZE;
      const w = Math.min(TILE_SIZE, width - originX);
      const h = Math.min(TILE_SIZE, height - originY);
      const tile = new Surface(TILE_SIZE, TILE_SIZE);
      fillPattern(tile, originX, originY, w, h, width, height);
      store.writeRegion(tile, originX, originY, rect(0, 0, w, h));
    }
  }
  return { width, height, layers: [{ store, mode: 0, opacity: 255, visible: true }] };
}
