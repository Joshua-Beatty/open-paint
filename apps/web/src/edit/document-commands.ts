import { type ClipboardService, clipboardSelection } from "@openpaint/codecs";
import {
  ClipboardError,
  type ClipboardImage,
  type ColorRgba8,
  Document,
  expandedCanvasSize,
  OutOfMemoryError,
  type PasteOptions,
  type Point,
  pasteExceedsCanvas,
  pastePosition,
  type Rect,
  rect,
  type SelectionCombineMode,
  type Size,
} from "@openpaint/document";
import type { MessageId } from "@openpaint/i18n";
import type { BuiltInCommandId } from "../commands/catalog";
import type { ShortcutController } from "../commands/shortcuts";

/** What the user chose for a paste that is larger than the canvas (DOC-CLP-05). */
export type PasteChoice = "expand" | "keep" | "cancel";

export interface DocumentCommandOptions {
  /** The image the commands act on, or undefined when no image is open. */
  readonly document: () => Document | undefined;
  readonly clipboard: ClipboardService;
  /** The Primary and Secondary colors, for Fill Selection (DOC-SEL-06e). */
  readonly primary: () => ColorRgba8;
  readonly secondary: () => ColorRgba8;
  /** Asks what to do with a paste larger than the canvas. Resolves to "cancel" on Esc. */
  readonly askPasteChoice: (image: ClipboardImage) => Promise<PasteChoice>;
  /** Opens a document as a new image tab (File > New, Paste into New Image). */
  readonly openDocument: (document: Document) => void;
  /**
   * Pastes `image` at `at` as floating content (DOC-CLP-05, TL-MOVE-PIX-01): the paste is recorded,
   * and the Move Selected Pixels tool takes over the pasted pixels.
   */
  readonly floatPaste: (
    document: Document,
    image: ClipboardImage,
    at: Point,
    options: PasteOptions,
  ) => void;
  /**
   * Gives pasted text to the active tool when it takes text (the Paste fallback, UI-MENU-EDIT).
   * Returns false when no tool takes it.
   */
  readonly pasteText: (text: string) => boolean;
  /** Zooms the view to an image rectangle (Zoom to Selection, UI-VIEW-01). */
  readonly zoomToArea: (area: Rect) => void;
  /** Tells the user about a refused clipboard or memory operation. */
  readonly notify: (messageId: MessageId) => void;
  /** Records whether the clipboard held nothing usable on the last read or write. */
  readonly setClipboardEmpty: (empty: boolean) => void;
  /** Reports any other failure to the error log. */
  readonly report: (cause: unknown) => void;
}

const SELECTION_MODES = {
  "edit.pasteSelectionReplace": "replace",
  "edit.pasteSelectionAdd": "union",
  "edit.pasteSelectionExclude": "exclude",
  "edit.pasteSelectionIntersect": "intersect",
  "edit.pasteSelectionXor": "xor",
} as const satisfies Partial<Record<BuiltInCommandId, SelectionCombineMode>>;

type PasteSelectionId = keyof typeof SELECTION_MODES;

const hasSelection = (doc: Document) => !doc.selection.isEmpty;
const always = () => true;

/**
 * Connects the Edit commands (UI-MENU-EDIT, DOC-SEL-06, DOC-CLP-01) and the Image pixel commands
 * (DOC-IMG-01 and the flips, rotations and Flatten) to the open image. The menus, the keys and the buttons
 * run them through the controller, so the enable rules match everywhere. Each enable rule mirrors
 * the one in `menus/menu-model.ts`. Returns the function that detaches every command.
 */
export function registerDocumentCommands(
  controller: ShortcutController<BuiltInCommandId>,
  options: DocumentCommandOptions,
): () => void {
  const attempt = async (work: () => Promise<void> | void): Promise<void> => {
    try {
      await work();
    } catch (error) {
      if (error instanceof ClipboardError) options.notify(error.messageId);
      else if (error instanceof OutOfMemoryError) options.notify("edit.outOfMemory");
      else options.report(error);
    }
  };
  const on = (
    id: BuiltInCommandId,
    enabled: (doc: Document) => boolean,
    run: (doc: Document) => Promise<void> | void,
  ) =>
    controller.register(id, {
      run: () => {
        const doc = options.document();
        if (doc !== undefined) void attempt(() => run(doc));
      },
      enabled: () => {
        const doc = options.document();
        return doc !== undefined && enabled(doc);
      },
    });

  /** A refused menu paste (WEB-CLIP-02) points the user at the paste shortcut instead. */
  const readClipboard = async () => {
    try {
      return await options.clipboard.read();
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        throw new ClipboardError("clipboard.pasteHint");
      }
      throw error;
    }
  };
  const copy = async (doc: Document, merged: boolean) => {
    const image = doc.copyPixels(merged);
    if (image === undefined) return;
    await options.clipboard.copyImage(image);
    options.setClipboardEmpty(false);
  };
  const cut = async (doc: Document) => {
    const image = doc.copyPixels(false);
    if (image === undefined) return;
    await options.clipboard.copyImage(image);
    doc.cutSelection();
    options.setClipboardEmpty(false);
  };
  const copySelection = async (doc: Document) => {
    await options.clipboard.copyOutline(doc.selection.effectivePolygons());
    options.setClipboardEmpty(false);
  };
  const paste = async (doc: Document, newLayer: boolean) => {
    const { image, text } = await readClipboard();
    if (!newLayer && image === undefined && text !== undefined && options.pasteText(text)) return;
    options.setClipboardEmpty(image === undefined);
    if (image === undefined) throw new ClipboardError("clipboard.noImage");
    const canvas: Size = { width: doc.width, height: doc.height };
    const size: Size = { width: image.pixels.width, height: image.pixels.height };
    let expandTo: Size | undefined;
    if (pasteExceedsCanvas(canvas, size)) {
      const choice = await options.askPasteChoice(image);
      if (choice === "cancel" || options.document() !== doc) return;
      if (choice === "expand") expandTo = expandedCanvasSize(canvas, size);
    }
    const target = expandTo ?? canvas;
    const at = pastePosition(target, size, rect(0, 0, canvas.width, canvas.height), image.origin);
    options.floatPaste(doc, image, at, {
      ...(newLayer ? { newLayer: true } : {}),
      ...(expandTo ? { expandTo } : {}),
    });
  };
  const pasteNewImage = async () => {
    const { image } = await readClipboard();
    options.setClipboardEmpty(image === undefined);
    if (image === undefined) throw new ClipboardError("clipboard.noUsableImage");
    options.openDocument(Document.fromClipboardImage(image));
  };
  const pasteSelection = async (doc: Document, mode: SelectionCombineMode) => {
    const contents = await readClipboard();
    const polygons = clipboardSelection(contents);
    options.setClipboardEmpty(polygons === undefined);
    if (polygons === undefined) throw new ClipboardError("clipboard.noSelectionOrImage");
    doc.pasteSelection(polygons, mode);
  };

  const releases = [
    on("edit.selectAll", always, (doc) => {
      doc.selectAll();
    }),
    on("edit.deselect", hasSelection, (doc) => {
      doc.deselect();
    }),
    on("edit.invertSelection", hasSelection, (doc) => {
      doc.invertSelection();
    }),
    on("edit.eraseSelection", hasSelection, (doc) => {
      doc.eraseSelection();
    }),
    on("edit.fillPrimary", always, (doc) => {
      doc.fillSelection(options.primary());
    }),
    on("edit.fillSecondary", always, (doc) => {
      doc.fillSelection(options.secondary());
    }),
    on("edit.copy", always, (doc) => copy(doc, false)),
    on("edit.copyMerged", always, (doc) => copy(doc, true)),
    on("edit.copySelection", hasSelection, copySelection),
    on("edit.cut", hasSelection, cut),
    on("edit.paste", always, (doc) => paste(doc, false)),
    on("edit.pasteIntoNewLayer", always, (doc) => paste(doc, true)),
    controller.register("edit.pasteIntoNewImage", {
      run: () => void attempt(pasteNewImage),
      enabled: always,
    }),
    ...(Object.keys(SELECTION_MODES) as PasteSelectionId[]).map((id) =>
      on(id, always, (doc) => pasteSelection(doc, SELECTION_MODES[id])),
    ),
    on("view.zoomToSelection", hasSelection, (doc) => {
      options.zoomToArea(doc.selection.bounds());
    }),
    on("image.crop", hasSelection, (doc) => {
      doc.cropToSelection();
    }),
    on("image.flipHorizontal", always, (doc) => {
      doc.flipImage("horizontal");
    }),
    on("image.flipVertical", always, (doc) => {
      doc.flipImage("vertical");
    }),
    on("image.rotate90Cw", always, (doc) => {
      doc.rotateImage("cw");
    }),
    on("image.rotate90Ccw", always, (doc) => {
      doc.rotateImage("ccw");
    }),
    on("image.rotate180", always, (doc) => {
      doc.rotateImage("half");
    }),
    on(
      "image.flatten",
      (doc) => doc.layerCount > 1,
      (doc) => {
        doc.flatten();
      },
    ),
  ];
  return () => {
    for (const release of releases) release();
  };
}
