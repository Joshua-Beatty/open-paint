// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { type ClipboardCodecs, type ClipboardEntry, ClipboardService } from "@openpaint/codecs";
import initWasm from "@openpaint/cpu";
import { type ClipboardImage, Document, type Rect, rect } from "@openpaint/document";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_REGISTRY, type BuiltInCommandId } from "../commands/catalog";
import { ShortcutController } from "../commands/shortcuts";
import {
  type DocumentCommandOptions,
  type PasteChoice,
  registerDocumentCommands,
} from "./document-commands";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const RED = { r: 255, g: 0, b: 0, a: 255 };
const BLUE = { r: 0, g: 0, b: 255, a: 255 };
const SELECTION_TYPE = "web application/x-openpaint-selection+json";

/** An in-memory system clipboard whose writes are visible to the next read. */
function memorySystem() {
  let entries: ClipboardEntry[] = [];
  return {
    write: vi.fn(async (written: Readonly<Record<string, Blob>>) => {
      entries = Object.entries(written).map(([type, blob]) => ({ type, blob }));
    }),
    read: vi.fn(async () => entries),
  };
}

const codecs: ClipboardCodecs = {
  encodePng: async () => new Uint8Array([137, 80, 78, 71]),
  decodeImage: async () => undefined,
};

function copyOf(doc: Document): ClipboardImage {
  const image = doc.copyPixels(false);
  if (image === undefined) throw new Error("nothing to copy");
  return image;
}

function pixelAt(doc: Document, x: number, y: number): number[] {
  const layer = doc.activeLayer;
  if (layer === undefined) throw new Error("no active layer");
  return [...layer.pixels.readRegion(rect(x, y, 1, 1)).data];
}

interface Harness {
  readonly controller: ShortcutController<BuiltInCommandId>;
  readonly doc: Document;
  readonly clipboard: ClipboardService;
  readonly system: ReturnType<typeof memorySystem>;
  readonly notify: ReturnType<typeof vi.fn<(id: string) => void>>;
  readonly setClipboardEmpty: ReturnType<typeof vi.fn<(empty: boolean) => void>>;
  readonly askPasteChoice: ReturnType<
    typeof vi.fn<(image: ClipboardImage) => Promise<PasteChoice>>
  >;
  readonly openDocument: ReturnType<typeof vi.fn<(document: Document) => void>>;
  readonly pasteText: ReturnType<typeof vi.fn<(text: string) => boolean>>;
  readonly zoomToArea: ReturnType<typeof vi.fn<(area: Rect) => void>>;
  readonly report: ReturnType<typeof vi.fn<(cause: unknown) => void>>;
  readonly release: () => void;
}

function harness(
  doc: Document = Document.createBlank({ width: 4, height: 4 }),
  choice: PasteChoice = "cancel",
): Harness {
  const system = memorySystem();
  const clipboard = new ClipboardService(system, codecs);
  const controller = new ShortcutController<BuiltInCommandId>(BUILT_IN_REGISTRY, "other");
  const notify = vi.fn<(id: string) => void>();
  const setClipboardEmpty = vi.fn<(empty: boolean) => void>();
  const askPasteChoice = vi.fn<(image: ClipboardImage) => Promise<PasteChoice>>(async () => choice);
  const openDocument = vi.fn<(document: Document) => void>();
  const pasteText = vi.fn<(text: string) => boolean>(() => false);
  const zoomToArea = vi.fn<(area: Rect) => void>();
  const report = vi.fn<(cause: unknown) => void>();
  const options: DocumentCommandOptions = {
    document: () => doc,
    clipboard,
    primary: () => RED,
    secondary: () => BLUE,
    askPasteChoice,
    openDocument,
    pasteText,
    floatPaste: (target, image, at, pasteOptions) => {
      target.pasteFloating(image, at, pasteOptions);
    },
    zoomToArea,
    notify,
    setClipboardEmpty,
    report,
  };
  const release = registerDocumentCommands(controller, options);
  return {
    controller,
    doc,
    clipboard,
    system,
    notify,
    setClipboardEmpty,
    askPasteChoice,
    openDocument,
    pasteText,
    zoomToArea,
    report,
    release,
  };
}

describe("document commands: selection and fill", () => {
  let state: Harness;

  beforeEach(() => {
    state = harness();
  });

  it("enables the selection commands only when the selection allows them", () => {
    const { controller } = state;
    expect(controller.isEnabled("edit.selectAll")).toBe(true);
    expect(controller.isEnabled("edit.deselect")).toBe(false);
    expect(controller.isEnabled("edit.invertSelection")).toBe(false);
    expect(controller.isEnabled("edit.eraseSelection")).toBe(false);
    expect(controller.isEnabled("edit.cut")).toBe(false);
    expect(controller.isEnabled("image.crop")).toBe(false);

    controller.invoke("edit.selectAll");
    expect(controller.isEnabled("edit.deselect")).toBe(true);
    expect(controller.isEnabled("edit.invertSelection")).toBe(true);
    expect(controller.isEnabled("edit.eraseSelection")).toBe(true);
    expect(controller.isEnabled("image.crop")).toBe(true);
  });

  it("selects all, inverts and deselects", () => {
    const { controller, doc } = state;
    controller.invoke("edit.selectAll");
    expect(doc.selection.isEmpty).toBe(false);
    controller.invoke("edit.deselect");
    expect(doc.selection.isEmpty).toBe(true);
    controller.invoke("edit.selectAll");
    controller.invoke("edit.invertSelection");
    expect(doc.selection.isEmpty).toBe(true);
  });

  it("fills the selection with the primary and the secondary color", () => {
    const { controller, doc } = state;
    controller.invoke("edit.selectAll");
    expect(controller.invoke("edit.fillPrimary")).toBe(true);
    expect(pixelAt(doc, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(controller.invoke("edit.fillSecondary")).toBe(true);
    expect(pixelAt(doc, 3, 3)).toEqual([0, 0, 255, 255]);
    expect(doc.history.undoName).toBe("Fill Selection");
  });

  it("erases the selection and deselects in one item", () => {
    const { controller, doc } = state;
    controller.invoke("edit.selectAll");
    controller.invoke("edit.eraseSelection");
    expect(pixelAt(doc, 1, 1)).toEqual([0, 0, 0, 0]);
    expect(doc.selection.isEmpty).toBe(true);
    expect(doc.history.undoName).toBe("Erase Selection");
  });

  it("zooms the view to the selection's bounds", () => {
    const { controller, doc, zoomToArea } = state;
    expect(controller.isEnabled("view.zoomToSelection")).toBe(false);
    doc.combineSelection([[1, 1, 3, 1, 3, 3, 1, 3]], "replace");
    expect(controller.invoke("view.zoomToSelection")).toBe(true);
    expect(zoomToArea).toHaveBeenLastCalledWith({ x: 1, y: 1, width: 2, height: 2 });
  });

  it("crops to the selection", () => {
    const { controller, doc } = state;
    doc.combineSelection([[1, 1, 3, 1, 3, 3, 1, 3]], "replace");
    expect(controller.invoke("image.crop")).toBe(true);
    expect(doc.width).toBe(2);
    expect(doc.height).toBe(2);
  });

  it("detaches every command when released", () => {
    const { controller, release } = state;
    release();
    expect(controller.isEnabled("edit.selectAll")).toBe(false);
    expect(controller.invoke("edit.selectAll")).toBe(false);
  });
});

describe("document commands: image operations", () => {
  it("flips and rotates the image as history items", () => {
    const { controller, doc } = harness();
    controller.invoke("image.flipHorizontal");
    expect(doc.history.undoName).toBe("Flip Horizontal (all)");
    controller.invoke("image.rotate90Cw");
    expect(doc.history.undoName).toBe("Rotate 90° CW");
    expect(doc.width).toBe(4);
    controller.invoke("image.rotate90Ccw");
    controller.invoke("image.rotate180");
    expect(doc.history.undoName).toBe("Rotate 180° (all)");
  });

  it("flattens only when there is more than one layer", () => {
    const { controller, doc } = harness();
    expect(controller.isEnabled("image.flatten")).toBe(false);
    doc.addLayer();
    expect(controller.isEnabled("image.flatten")).toBe(true);
    controller.invoke("image.flatten");
    expect(doc.layerCount).toBe(1);
  });

  it("is disabled everywhere without an open image", () => {
    const controller = new ShortcutController<BuiltInCommandId>(BUILT_IN_REGISTRY, "other");
    registerDocumentCommands(controller, {
      document: () => undefined,
      clipboard: new ClipboardService(memorySystem(), codecs),
      primary: () => RED,
      secondary: () => BLUE,
      askPasteChoice: async () => "cancel",
      openDocument: () => undefined,
      pasteText: () => false,
      floatPaste: () => undefined,
      zoomToArea: () => undefined,
      notify: () => undefined,
      setClipboardEmpty: () => undefined,
      report: () => undefined,
    });
    expect(controller.isEnabled("edit.selectAll")).toBe(false);
    expect(controller.isEnabled("image.flipVertical")).toBe(false);
    expect(controller.isEnabled("edit.pasteIntoNewImage")).toBe(true);
  });
});

describe("document commands: clipboard", () => {
  it("copies and pastes into a new layer", async () => {
    const { controller, doc, system } = harness();
    controller.invoke("edit.copy");
    await vi.waitFor(() => expect(system.write).toHaveBeenCalled());
    expect(system.write.mock.lastCall?.[0]).toHaveProperty("image/png");

    controller.invoke("edit.pasteIntoNewLayer");
    await vi.waitFor(() => expect(doc.layerCount).toBe(2));
    expect(doc.history.undoName).toBe("Paste into New Layer");
  });

  it("cuts the selection to the clipboard and erases it", async () => {
    const { controller, doc, system } = harness();
    controller.invoke("edit.selectAll");
    controller.invoke("edit.cut");
    await vi.waitFor(() => expect(pixelAt(doc, 0, 0)).toEqual([0, 0, 0, 0]));
    expect(system.write).toHaveBeenCalled();
    expect(doc.history.undoName).toBe("Cut");
  });

  it("reports an empty clipboard instead of pasting", async () => {
    const { controller, doc, notify, setClipboardEmpty } = harness();
    controller.invoke("edit.paste");
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("clipboard.noImage"));
    expect(setClipboardEmpty).toHaveBeenLastCalledWith(true);
    expect(doc.layerCount).toBe(1);
  });

  it("gives plain text to the active tool when the clipboard holds no image", async () => {
    const { controller, doc, system, pasteText, notify } = harness();
    pasteText.mockReturnValueOnce(true);
    await system.write({ "text/plain": new Blob(["Hello"]) });
    controller.invoke("edit.paste");
    await vi.waitFor(() => expect(pasteText).toHaveBeenCalledWith("Hello"));
    expect(notify).not.toHaveBeenCalled();
    expect(doc.history.canUndo).toBe(false);
  });

  it("points a refused menu paste at the paste shortcut (WEB-CLIP-02)", async () => {
    const { controller, doc, clipboard, notify, report } = harness();
    vi.spyOn(clipboard, "read").mockRejectedValueOnce(
      new DOMException("denied", "NotAllowedError"),
    );
    controller.invoke("edit.paste");
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("clipboard.pasteHint"));
    expect(report).not.toHaveBeenCalled();
    expect(doc.layerCount).toBe(1);
  });

  it("reports an empty clipboard when no tool takes the text", async () => {
    const { controller, system, pasteText, notify } = harness();
    await system.write({ "text/plain": new Blob(["Hello"]) });
    controller.invoke("edit.paste");
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("clipboard.noImage"));
    expect(pasteText).toHaveBeenCalledWith("Hello");
  });

  it("expands the canvas to fit a larger paste when the user agrees", async () => {
    const { controller, doc, clipboard, askPasteChoice } = harness(
      Document.createBlank({ width: 4, height: 4 }),
      "expand",
    );
    const big = Document.createBlank({ width: 8, height: 8 });
    await clipboard.copyImage(copyOf(big));
    controller.invoke("edit.paste");
    await vi.waitFor(() => expect(doc.width).toBe(8));
    expect(askPasteChoice).toHaveBeenCalledTimes(1);
    expect(doc.height).toBe(8);
    expect(doc.history.undoName).toBe("Canvas Size");
  });

  it("keeps the canvas size when the user declines to expand", async () => {
    const { controller, doc, clipboard, askPasteChoice } = harness(undefined, "keep");
    await clipboard.copyImage(copyOf(Document.createBlank({ width: 8, height: 8 })));
    controller.invoke("edit.paste");
    await vi.waitFor(() => expect(doc.history.undoName).toBe("Paste"));
    expect(askPasteChoice).toHaveBeenCalledTimes(1);
    expect(doc.width).toBe(4);
  });

  it("changes nothing when the paste prompt is cancelled", async () => {
    const { controller, doc, clipboard, askPasteChoice } = harness(undefined, "cancel");
    await clipboard.copyImage(copyOf(Document.createBlank({ width: 8, height: 8 })));
    controller.invoke("edit.paste");
    await vi.waitFor(() => expect(askPasteChoice).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(doc.width).toBe(4);
    expect(doc.layerCount).toBe(1);
  });

  it("pastes the copied image as a new image", async () => {
    const { controller, clipboard, openDocument } = harness();
    await clipboard.copyImage(copyOf(Document.createBlank({ width: 8, height: 8 })));
    controller.invoke("edit.pasteIntoNewImage");
    await vi.waitFor(() => expect(openDocument).toHaveBeenCalledTimes(1));
    expect(openDocument.mock.lastCall?.[0].width).toBe(8);
  });

  it("copies a selection outline and pastes it as a selection", async () => {
    const { controller, doc, system } = harness();
    doc.combineSelection([[0, 0, 2, 0, 2, 2, 0, 2]], "replace");
    controller.invoke("edit.copySelection");
    await vi.waitFor(() => expect(system.write).toHaveBeenCalled());
    expect(system.write.mock.lastCall?.[0]).toHaveProperty(SELECTION_TYPE);

    doc.deselect();
    controller.invoke("edit.pasteSelectionReplace");
    await vi.waitFor(() => expect(doc.selection.isEmpty).toBe(false));
    expect(doc.history.undoName).toBe("Paste Selection");
  });

  it("reports a paste selection with nothing usable on the clipboard", async () => {
    const { controller, notify } = harness();
    controller.invoke("edit.pasteSelectionAdd");
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("clipboard.noSelectionOrImage"));
  });
});
