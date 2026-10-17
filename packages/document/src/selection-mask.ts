import { rasterize_polygons } from "@openpaint/cpu";
import type { Rect } from "./geometry";
import { rectPolygon, type SelectionPolygon, type SelectionQuality } from "./selection-polygons";

/**
 * Rasterizes a polygon set over `area` into a row-major mask of one byte per pixel (DOC-SEL-03).
 * Aliased masks hold 0 or 255 by pixel-center sampling. Antialiased masks hold coverage 0-255.
 */
export function rasterizeSelection(
  polygons: readonly SelectionPolygon[],
  area: Rect,
  quality: SelectionQuality,
): Uint8Array {
  let vertexCount = 0;
  for (const polygon of polygons) vertexCount += polygon.length / 2;
  const coords = new Float64Array(vertexCount * 2);
  const counts = new Uint32Array(polygons.length);
  let k = 0;
  polygons.forEach((polygon, i) => {
    counts[i] = polygon.length / 2;
    for (let j = 0; j < polygon.length; j++) {
      coords[k++] = (polygon[j] ?? 0) - (j % 2 === 0 ? area.x : area.y);
    }
  });
  return rasterize_polygons(coords, counts, area.width, area.height, quality === "antialiased");
}

/**
 * One rectangle per horizontal run of set pixels in a `width` x `height` mask, so that a pixel-
 * aligned mask becomes a polygon set with exact pixel edges (the DOC-SEL-06c pixel-scan path).
 */
export function maskRunPolygons(
  mask: Uint8Array,
  width: number,
  height: number,
): SelectionPolygon[] {
  const polygons: SelectionPolygon[] = [];
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      if ((mask[y * width + x] ?? 0) === 0) {
        x++;
        continue;
      }
      const start = x;
      while (x < width && (mask[y * width + x] ?? 0) !== 0) x++;
      polygons.push(rectPolygon({ x: start, y, width: x - start, height: 1 }));
    }
  }
  return polygons;
}
