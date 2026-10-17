import { Surface } from "@openpaint/document";
import { EXIF_TAG_ORIENTATION, exifOrientation, removeExifTag } from "./exif";

/**
 * Source coordinates for destination pixel (x, y) under EXIF orientation 1 to 8. `w` and `h` are the
 * source size. Orientations 5 to 8 turn the image on its side, so the destination is h by w.
 */
function sourceOf(
  orientation: number,
  w: number,
  h: number,
  x: number,
  y: number,
): [number, number] {
  switch (orientation) {
    case 2:
      return [w - 1 - x, y];
    case 3:
      return [w - 1 - x, h - 1 - y];
    case 4:
      return [x, h - 1 - y];
    case 5:
      return [y, x];
    case 6:
      return [y, h - 1 - x];
    case 7:
      return [w - 1 - y, h - 1 - x];
    case 8:
      return [w - 1 - y, x];
    default:
      return [x, y];
  }
}

/** The pixels of `surface` turned or mirrored as the EXIF Orientation tag asks, upright. */
export function orientSurface(surface: Surface, orientation: number): Surface {
  const { width: w, height: h } = surface;
  const turned = orientation >= 5;
  const outWidth = turned ? h : w;
  const outHeight = turned ? w : h;
  const out = new Surface(outWidth, outHeight);
  const src = surface.data;
  const dst = out.data;
  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      const [sx, sy] = sourceOf(orientation, w, h, x, y);
      const from = (sy * w + sx) * 4;
      const to = (y * outWidth + x) * 4;
      dst[to] = src[from] ?? 0;
      dst[to + 1] = src[from + 1] ?? 0;
      dst[to + 2] = src[from + 2] ?? 0;
      dst[to + 3] = src[from + 3] ?? 0;
    }
  }
  return out;
}

/**
 * Brings a decoded image upright and removes the Orientation tag from its EXIF block (FMT-META-02),
 * so a later save or reload does not rotate it again. A normal or absent orientation changes nothing.
 */
export function applyExifOrientation(
  surface: Surface,
  exif: Uint8Array | undefined,
): { readonly surface: Surface; readonly exif: Uint8Array | undefined } {
  const orientation = exifOrientation(exif);
  if (exif === undefined || orientation === undefined || orientation < 2 || orientation > 8) {
    return { surface, exif };
  }
  return {
    surface: orientSurface(surface, orientation),
    exif: removeExifTag(exif, EXIF_TAG_ORIENTATION),
  };
}
