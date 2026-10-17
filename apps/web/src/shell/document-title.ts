import type { Translate } from "@openpaint/i18n";
import { useEffect } from "react";

/** What the window title shows about the active image (UI-WIN-03). */
export interface TitleDocument {
  /** The file path or name, when the image has been saved or opened from a file. */
  path?: string;
  dirty: boolean;
}

/** The file name without any directory part, as the title shows it (UI-WIN-03). */
export function fileDisplayName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

/**
 * The `document.title` for the state: the app name with no image open, otherwise
 * "{name} - OpenPaint", with a `*` before the whole title while the image has unsaved changes.
 */
export function documentTitle(doc: TitleDocument | null, t: Translate): string {
  const app = t("app.name");
  if (doc === null) return app;
  const name = (doc.path ? fileDisplayName(doc.path) : "") || t("document.untitled");
  return t(doc.dirty ? "document.titleDirty" : "document.title", { name, app });
}

/** Keeps `document.title` equal to `documentTitle` for the active image. */
export function useDocumentTitle(doc: TitleDocument | null, t: Translate): void {
  const title = documentTitle(doc, t);
  useEffect(() => {
    document.title = title;
  }, [title]);
}
