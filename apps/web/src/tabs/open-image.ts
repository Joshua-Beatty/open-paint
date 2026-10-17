import type { Document } from "@openpaint/document";

/**
 * Where the image was last opened from or saved to (FMT-SAVE-01). `handle` is set when the browser
 * gave a file handle, so Save can write back to it. Without one, Save behaves as Save As.
 */
export interface ImageFile {
  readonly typeId: string;
  readonly handle?: FileSystemFileHandle | undefined;
}

/** An image open in the session: its document, the name its tab shows and its file, if any. */
export interface OpenImage {
  readonly name: string;
  readonly document: Document;
  readonly file?: ImageFile | undefined;
}
