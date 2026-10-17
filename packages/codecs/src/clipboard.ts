import {
  bytesOf,
  ClipboardError,
  type ClipboardImage,
  canvasOutline,
  formatSelectionOutline,
  isValidImageSize,
  OutOfMemoryError,
  parseSelectionOutline,
  type SelectionPolygon,
  type Surface,
} from "@openpaint/document";
import type { RgbaImage } from "./png";

/** The PNG clipboard type (DOC-CLP-02.2). */
export const PNG_TYPE = "image/png";

/**
 * The app's selection-outline type (DOC-CLP-03). Chromium accepts custom types only with the
 * "web " prefix (WEB-CLIP-01).
 */
export const SELECTION_TYPE = "web application/x-openpaint-selection+json";

const TEXT_TYPE = "text/plain";
const HTML_TYPE = "text/html";
const DATA_URI = /^data:(image\/(?:png|bmp|jpeg|gif));base64,([A-Za-z0-9+/=]+)$/;
const HTML_IMAGE_SOURCE = /<img\b[^>]*\bsrc="(data:[^"]+)"/i;

/** One typed item on the system clipboard. */
export interface ClipboardEntry {
  readonly type: string;
  readonly blob: Blob;
}

/** The operating system clipboard, as the Async Clipboard API exposes it (WEB-CLIP-01/02). */
export interface SystemClipboard {
  /** Replaces the clipboard contents with one item holding these typed blobs. */
  write(entries: Readonly<Record<string, Blob>>): Promise<void>;
  /** Reads every type the clipboard offers. May prompt for permission. */
  read(): Promise<readonly ClipboardEntry[]>;
}

/** The image codecs the clipboard needs. */
export interface ClipboardCodecs {
  /** Encodes straight-alpha pixels as PNG bytes tagged sRGB. */
  encodePng(image: RgbaImage): Promise<Uint8Array>;
  /** Decodes an image blob, or returns undefined when its format cannot be decoded. */
  decodeImage(blob: Blob): Promise<Surface | undefined>;
}

/** What a read of the clipboard found. Either part may be missing (DOC-CLP-04, DOC-CLP-03). */
export interface ClipboardContents {
  readonly image: ClipboardImage | undefined;
  readonly outline: readonly SelectionPolygon[] | undefined;
  /**
   * The plain text, unless it is a selection outline (DOC-CLP-03). The Paste fallback gives it to a
   * tool that takes text, such as the Text tool (UI-MENU-EDIT).
   */
  readonly text: string | undefined;
}

/**
 * The selection a Paste Selection combines: the outline on the clipboard, else the mask or bounds
 * of the clipboard image (DOC-CLP-01h).
 */
export function clipboardSelection(
  contents: Pick<ClipboardContents, "image" | "outline">,
): readonly SelectionPolygon[] | undefined {
  if (contents.outline) return contents.outline;
  return contents.image ? canvasOutline(contents.image) : undefined;
}

/**
 * Copies to and reads from the system clipboard. It also keeps the last in-app copy, so a paste
 * can restore the exact pixels and position while the system clipboard still holds that copy
 * (WEB-CLIP-03). The copy is recognized by a SHA-256 of its PNG bytes.
 */
export class ClipboardService {
  readonly #system: SystemClipboard;
  readonly #codecs: ClipboardCodecs;
  #inApp: { readonly digest: string; readonly image: ClipboardImage } | undefined;

  constructor(system: SystemClipboard, codecs: ClipboardCodecs) {
    this.#system = system;
    this.#codecs = codecs;
  }

  /**
   * DOC-CLP-02: writes the copied image as PNG and, when it has a selection, as the outline. The
   * write replaces everything on the clipboard. The in-app copy is kept only if the write succeeds.
   */
  async copyImage(image: ClipboardImage): Promise<void> {
    const png = await this.#encode(image);
    const entries: Record<string, Blob> = {
      [PNG_TYPE]: new Blob([png.slice()], { type: PNG_TYPE }),
    };
    if (image.outline)
      entries[SELECTION_TYPE] = textBlob(
        formatSelectionOutline(canvasOutline(image)),
        SELECTION_TYPE,
      );
    await this.#write(entries);
    this.#inApp = { digest: await digestOf(png), image };
  }

  /** DOC-CLP-01d: writes only the outline, as the custom type and as text (DOC-CLP-03). */
  async copyOutline(polygons: readonly SelectionPolygon[]): Promise<void> {
    const text = formatSelectionOutline(polygons);
    await this.#write({
      [SELECTION_TYPE]: textBlob(text, SELECTION_TYPE),
      [TEXT_TYPE]: textBlob(text, TEXT_TYPE),
    });
  }

  /** Reads the system clipboard. Throws what the browser throws, e.g. when permission is denied. */
  async read(): Promise<ClipboardContents> {
    return this.readEntries(await this.#system.read());
  }

  /** Interprets typed clipboard entries, from the system clipboard or a paste event. */
  async readEntries(entries: readonly ClipboardEntry[]): Promise<ClipboardContents> {
    const outline = await this.#outlineOf(entries);
    const plain = entries.find((entry) => entry.type === TEXT_TYPE);
    return {
      image: await this.#imageOf(entries),
      outline,
      text: outline === undefined && plain ? await plain.blob.text() : undefined,
    };
  }

  async #write(entries: Record<string, Blob>): Promise<void> {
    try {
      await this.#system.write(entries);
    } catch {
      throw new ClipboardError("clipboard.copyError");
    }
  }

  async #encode(image: ClipboardImage): Promise<Uint8Array> {
    try {
      return await this.#codecs.encodePng(rgbaOf(image.pixels));
    } catch (error) {
      if (error instanceof OutOfMemoryError) throw new ClipboardError("clipboard.outOfMemory");
      throw error;
    }
  }

  /** The first selection outline on the clipboard, custom type before text. */
  async #outlineOf(
    entries: readonly ClipboardEntry[],
  ): Promise<readonly SelectionPolygon[] | undefined> {
    for (const type of [SELECTION_TYPE, TEXT_TYPE]) {
      const entry = entries.find((candidate) => candidate.type === type);
      const outline = entry ? parseSelectionOutline(await entry.blob.text()) : undefined;
      if (outline) return outline;
    }
    return undefined;
  }

  /**
   * The first usable image, in DOC-CLP-04 order: the in-app copy when its PNG is still on the
   * clipboard, then PNG, other image types, and base64 data URIs in text.
   */
  async #imageOf(entries: readonly ClipboardEntry[]): Promise<ClipboardImage | undefined> {
    const png = entries.find((entry) => entry.type === PNG_TYPE);
    const inApp = this.#inApp;
    if (png && inApp) {
      const digest = await digestOf(new Uint8Array(await png.blob.arrayBuffer()));
      if (digest === inApp.digest) return inApp.image;
    }
    const images = [
      ...entries.filter((entry) => entry.type === PNG_TYPE),
      ...entries.filter((entry) => entry.type.startsWith("image/") && entry.type !== PNG_TYPE),
    ];
    for (const entry of images) {
      const pixels = await this.#decode(entry.blob);
      if (pixels) return { pixels };
    }
    for (const entry of entries.filter(
      (item) => item.type === TEXT_TYPE || item.type === HTML_TYPE,
    )) {
      const text = await entry.blob.text();
      for (const candidate of [text, HTML_IMAGE_SOURCE.exec(text)?.[1] ?? ""]) {
        const blob = dataUriBlob(candidate);
        const pixels = blob ? await this.#decode(blob) : undefined;
        if (pixels) return { pixels };
      }
    }
    return undefined;
  }

  async #decode(blob: Blob): Promise<Surface | undefined> {
    try {
      const pixels = await this.#codecs.decodeImage(blob);
      return pixels && isValidImageSize(pixels.width, pixels.height) ? pixels : undefined;
    } catch {
      return undefined;
    }
  }
}

function rgbaOf(surface: Surface): RgbaImage {
  return { width: surface.width, height: surface.height, data: bytesOf(surface) };
}

/** Text typed as its clipboard entry: Chromium refuses an entry whose blob has another type. */
function textBlob(text: string, type: string): Blob {
  return new Blob([text], { type });
}

/** The image in a base64 data URI, or undefined when the text is not one. */
function dataUriBlob(candidate: string): Blob | undefined {
  const match = DATA_URI.exec(candidate.trim());
  if (!match?.[1] || !match[2]) return undefined;
  try {
    const bytes = Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0));
    return new Blob([bytes], { type: match[1] });
  } catch {
    return undefined;
  }
}

async function digestOf(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes.slice());
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
