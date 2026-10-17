import { Surface } from "@openpaint/document";
import type { ClipboardCodecs, ClipboardEntry, SystemClipboard } from "./clipboard";
import { srgbPixelsOf } from "./icc-transform";
import { encodePngAsync } from "./png";
import { readPngMetadata } from "./png-metadata";
import { decodePngPixels } from "./png-raster";
import { deflateZlib } from "./zlib";

/** The `ClipboardItem` constructor, with the static `supports` that newer browsers have. */
export interface ClipboardItemClass {
  new (items: Record<string, Blob>): ClipboardItem;
  supports?(type: string): boolean;
}

/** Custom clipboard types carry this prefix (WEB-CLIP-01). */
const CUSTOM_TYPE_PREFIX = "web ";

/**
 * The system clipboard through the Async Clipboard API (WEB-CLIP-01/02). Types the browser cannot
 * write are left out, so a copy still writes its PNG and text where custom `web ` types are
 * unsupported (Firefox): `ClipboardItem.supports` decides where it exists, otherwise a rejected
 * item is built again without the custom types.
 */
export function browserClipboard(
  clipboard: Clipboard = navigator.clipboard,
  itemClass?: ClipboardItemClass,
): SystemClipboard {
  const item = (entries: Readonly<Record<string, Blob>>): ClipboardItem => {
    const Item: ClipboardItemClass = itemClass ?? ClipboardItem;
    const supports = Item.supports?.bind(Item);
    const writable = Object.entries(entries).filter(([type]) => supports?.(type) ?? true);
    try {
      return new Item(Object.fromEntries(writable));
    } catch (error) {
      const standard = writable.filter(([type]) => !type.startsWith(CUSTOM_TYPE_PREFIX));
      if (!(error instanceof TypeError) || standard.length === writable.length) throw error;
      return new Item(Object.fromEntries(standard));
    }
  };
  return {
    async write(entries) {
      await clipboard.write([item(entries)]);
    },
    async read() {
      const entries: ClipboardEntry[] = [];
      for (const item of await clipboard.read()) {
        for (const type of item.types) entries.push({ type, blob: await item.getType(type) });
      }
      return entries;
    },
  };
}

/**
 * PNG encoding in pure TypeScript over `CompressionStream`. PNG clipboard data decodes in WASM like
 * a PNG file (WEB-FILE-07). Other types decode in the browser.
 */
export function browserCodecs(): ClipboardCodecs {
  return {
    encodePng: (image) => encodePngAsync(image, deflateZlib),
    decodeImage: (blob) =>
      blob.type === "image/png" ? decodePngBlob(blob) : decodeWithBrowser(blob),
  };
}

async function decodePngBlob(blob: Blob): Promise<Surface> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const raster = decodePngPixels(bytes);
  const { icc } = await readPngMetadata(bytes);
  const { pixels } = await srgbPixelsOf({
    width: raster.width,
    height: raster.height,
    pixels: raster.pixels,
    pixelsPerMeter: { x: 0, y: 0 },
    ...(icc === undefined ? {} : { icc }),
  });
  return new Surface(raster.width, raster.height, new Uint8ClampedArray(pixels));
}

/**
 * The decode options for the file loaders. The browser leaves the EXIF Orientation alone, so the
 * loader applies it once and removes the tag (FMT-META-02).
 */
export const UPRIGHT_DECODE_OPTIONS: ImageBitmapOptions = { imageOrientation: "none" };

/**
 * Decodes through `createImageBitmap`. The browser applies the image's color profile and returns
 * sRGB pixels (DOC-CLP-04).
 */
/** A 2D context for reading pixels back. WebKit has no OffscreenCanvas, so it reads from a page canvas. */
function readbackContext(width: number, height: number): OffscreenCanvasRenderingContext2D | null {
  const options = { willReadFrequently: true };
  if (typeof OffscreenCanvas === "function") {
    return new OffscreenCanvas(width, height).getContext("2d", options);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas.getContext("2d", options) as OffscreenCanvasRenderingContext2D | null;
}

export async function decodeWithBrowser(
  blob: Blob,
  options?: ImageBitmapOptions,
): Promise<Surface | undefined> {
  const bitmap = await createImageBitmap(blob, options);
  try {
    const context = readbackContext(bitmap.width, bitmap.height);
    if (!context) return undefined;
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return new Surface(bitmap.width, bitmap.height, data);
  } finally {
    bitmap.close();
  }
}
