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

/**
 * True for an image that holds nothing a user could lose: named `untitled` (the name a new image
 * gets), without a file, and with the content of a new blank image, whatever selections, undone
 * edits or put-back properties it has (owner request). Such an image is not checkpointed, not
 * offered for restore, and not unsaved work.
 */
export function isBlankImage(image: OpenImage, untitled: string | undefined): boolean {
  return image.file === undefined && image.name === untitled && image.document.untouchedBlank;
}

/**
 * True when the image has changes that have not been saved and that are worth saving: it is dirty
 * and not a blank image (`isBlankImage`). The unsaved-changes prompts, the leave-page prompt, Save
 * All, the tab's unsaved dot and the window title all follow it.
 */
export function hasUnsavedWork(image: OpenImage, untitled: string | undefined): boolean {
  return image.document.dirty && !isBlankImage(image, untitled);
}
