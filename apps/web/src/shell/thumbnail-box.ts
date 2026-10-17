/** A width and a height, in CSS pixels or image pixels. */
export interface BoxSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The CSS size that shows an image of `size` at its own aspect ratio, as large as fits in `max`
 * (UI-FTW-05, UI-TABS-01). The checkerboard is drawn in this box only, so it never shows as a band
 * beside the image. An image with no area takes the whole box.
 */
export function thumbnailBox(size: BoxSize, max: BoxSize): BoxSize {
  if (!(size.width > 0 && size.height > 0)) return max;
  const scale = Math.min(max.width / size.width, max.height / size.height);
  return {
    width: Math.max(1, Math.min(max.width, Math.round(size.width * scale))),
    height: Math.max(1, Math.min(max.height, Math.round(size.height * scale))),
  };
}
