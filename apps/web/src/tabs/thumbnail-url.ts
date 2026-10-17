import { type Document, type Surface, ThumbnailRenderer } from "@openpaint/document";
import { yieldToHost } from "../workers/yield-to-host";

/** The longer side of a tab thumbnail, in pixels, twice the 28 CSS px height for high-DPI screens. */
export const TAB_THUMBNAIL_SIZE = 56;

/** The shortest time between two thumbnail renders of one image, in milliseconds (UI-TABS-01). */
export const TAB_THUMBNAIL_INTERVAL_MS = 250;

/** Encodes a surface as a PNG data URL, which keeps its transparency for the checkerboard. */
export function surfaceToDataUrl(surface: Surface): string | undefined {
  const canvas = document.createElement("canvas");
  canvas.width = surface.width;
  canvas.height = surface.height;
  // A software canvas: encoding a GPU canvas reads it back from the GPU, which waits for the GPU
  // and stalled thumbnails while the engine uploaded a new image (L7).
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) return undefined;
  context.putImageData(new ImageData(surface.data, surface.width, surface.height), 0, 0);
  return canvas.toDataURL("image/png");
}

/** The data URL of each thumbnail surface, so a thumbnail that did not change is not encoded again. */
const encoded = new WeakMap<Surface, string | undefined>();

/** `surfaceToDataUrl`, remembered for the surface. */
export function cachedDataUrl(surface: Surface): string | undefined {
  if (encoded.has(surface)) return encoded.get(surface);
  const url = surfaceToDataUrl(surface);
  encoded.set(surface, url);
  return url;
}

const tabThumbnails = new ThumbnailRenderer(TAB_THUMBNAIL_SIZE);

/**
 * The tab thumbnail. Only the tiles changed since the last one are composited again, in slices so
 * no single turn of the event loop runs long (L8, PRD-NF-02). `pause` runs between slices.
 */
export async function tabThumbnailUrl(
  doc: Document,
  pause: () => Promise<void> = yieldToHost,
): Promise<string | undefined> {
  return cachedDataUrl(await tabThumbnails.document(doc, pause));
}
