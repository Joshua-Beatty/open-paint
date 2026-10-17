import {
  allocateWithBudget,
  Document,
  documentThumbnail,
  expandedCanvasSize,
  type LayerBlendMode,
  OutOfMemoryError,
  pasteExceedsCanvas,
  rect,
  type Size,
} from "@openpaint/document";
import {
  type FileCodec,
  type FileDocument,
  type FileTypeDescriptor,
  type FileTypeRegistry,
  findOpenFileType,
  openFileTypes,
  saveFileTypes,
  sniffFileType,
} from "@openpaint/extension-api";
import type { MessageId, Translate } from "@openpaint/i18n";
import { PropertyCollection, type PropertyValues } from "@openpaint/properties";
import type { RecentFiles } from "@openpaint/storage";
import { newDocumentAccountant } from "../errors/memory-budget";
import { type Printer, printLayout } from "../print/print-job";
import type { ImageTabs } from "../tabs/image-tabs";
import type { OpenImage } from "../tabs/open-image";
import { engineStrokesSettled } from "../tools/engine-stroke";
import { type DroppedSources, fetchDroppedImage, remoteFileName } from "./dropped-sources";
import { type FileAccess, type OpenedFile, openedFileOf } from "./file-access";
import {
  extensionOf,
  openPickerTypes,
  resolveDownloadName,
  savePickerTypes,
  suggestedName,
  typeOfName,
} from "./file-choices";
import type { FileDialogRequest, FileDialogs, SaveConfigChoice } from "./file-dialogs";
import {
  CodecUnavailableError,
  failureText,
  openFailure,
  saveFailure,
  UnrecognizedFileError,
} from "./file-errors";
import type { SaveConfigStore } from "./save-config";

/** The side of an Open Recent thumbnail in CSS pixels (FMT-OPEN-06). */
const RECENT_THUMBNAIL_SIZE = 64;

/** The name of the one layer a flat file is written from. Flat formats do not store layer names. */
const FLAT_LAYER_NAME = "Background";

/** How a save ended. A failed save has already told the user why. */
export type SaveOutcome = "saved" | "canceled" | "failed";

/** A file that loaded: its image, and the catalog keys of the warnings its load raised. */
interface LoadedImage {
  readonly image: OpenImage;
  readonly warnings: readonly string[];
}

export interface FileFlowOptions {
  readonly registry: FileTypeRegistry;
  readonly access: FileAccess;
  readonly dialogs: FileDialogs;
  readonly recent: RecentFiles;
  /** The last-used save options of each type (FMT-UI-01). */
  readonly saveConfig: SaveConfigStore;
  readonly tabs: ImageTabs<OpenImage>;
  readonly t: Translate;
  /** Adds an image as a new tab and fits the view to it. */
  readonly openImage: (image: OpenImage) => void;
  /** A PNG data URL of the document, scaled so that its longer side is `maxSize` pixels. */
  readonly thumbnail: (document: Document, maxSize: number) => string | undefined;
  readonly devicePixelRatio: () => number;
  /** The browser's printing (FMT-PRN-01). */
  readonly printer: Printer;
  /** The size of a new blank image, for dropped files added as layers with no image open (DOC-NEW-01). */
  readonly newImageSize: () => Size;
  /** Shows a message the user must read, such as a failed open or save. */
  readonly notify: (text: string) => void;
  /** Reports an unexpected error to the error log. */
  readonly report: (cause: unknown) => void;
}

/**
 * The open and save flows (FMT-OPEN, FMT-SAVE, WEB-FILE-01..04): picking files, choosing a type by
 * extension, loading through the file type's codec, encoding fully before the atomic write, and
 * keeping Open Recent up to date. The dialogs they show go through `FileDialogs`.
 */
export class FileFlows {
  readonly #options: FileFlowOptions;
  readonly #codecs = new Map<string, Promise<FileCodec>>();
  readonly #unavailable = new Map<string, { readonly cause: unknown }>();

  constructor(options: FileFlowOptions) {
    this.#options = options;
  }

  /** Runs a flow started by a command or a menu. Errors the flow does not handle go to the log. */
  run(task: () => Promise<unknown>): void {
    task().catch((cause: unknown) => this.#options.report(cause));
  }

  /** File > Open (FMT-OPEN-01): each picked file opens as its own image. */
  async openFiles(): Promise<void> {
    const { access, t } = this.#options;
    const picked = await access.pickFiles(openPickerTypes(this.#loadable(), t));
    await this.#transfer(picked, (loaded) => this.#openLoaded(loaded));
  }

  /**
   * Open Recent (FMT-OPEN-06). An entry without a handle opens the picker. A file that is gone or
   * no longer readable is removed from the list and reported.
   */
  async openRecent(id: number): Promise<void> {
    const { recent, access, notify, t } = this.#options;
    const entry = recent.get(id);
    if (entry === undefined) return;
    if (entry.handle === undefined) {
      await this.openFiles();
      return;
    }
    let file: OpenedFile;
    try {
      file = await access.openHandle(entry.handle);
    } catch (error) {
      const message = openFailure(error);
      if (message.id === "file.error.notFound" || message.id === "file.error.access") {
        recent.remove(id);
      }
      notify(failureText(message, t));
      return;
    }
    await this.#transfer([file], (loaded) => this.#openLoaded(loaded));
  }

  clearRecent(): void {
    this.#options.recent.clear();
  }

  /**
   * Layers > Import From File (DOC-LYR-05e): each picked file becomes a new layer of the image that
   * is active when the command runs.
   */
  async importFromFile(): Promise<void> {
    const id = this.#options.tabs.active?.id;
    if (id === undefined) return;
    const { access, t } = this.#options;
    const picked = await access.pickFiles(openPickerTypes(this.#loadable(), t));
    await this.#transfer(picked, (loaded) => this.#importLoaded(id, loaded));
  }

  /** Files the OS launched the app with (WEB-FILE-05). Each opens as a tab, in the order given. */
  async openHandles(handles: readonly FileSystemFileHandle[]): Promise<void> {
    const { access, notify, t } = this.#options;
    const files: OpenedFile[] = [];
    for (const handle of handles) {
      try {
        files.push(await access.openHandle(handle));
      } catch (error) {
        notify(failureText(openFailure(error), t));
      }
    }
    await this.#transfer(files, (loaded) => this.#openLoaded(loaded));
  }

  /**
   * Files and image addresses dropped on the app (UI-DOC-02, WEB-FILE-06). Folders were already
   * removed. A single file with no image open opens directly. Otherwise the Drag and Drop question
   * decides between opening the files and adding them as layers, which creates a new image first
   * when none is open.
   */
  async dropped(sources: DroppedSources): Promise<void> {
    const files = [...sources.files.map(openedFileOf), ...(await this.#fetchRemote(sources.urls))];
    if (files.length === 0) return;
    const { dialogs, tabs } = this.#options;
    const hasImage = tabs.active !== undefined;
    if (files.length === 1 && !hasImage) {
      await this.#transfer(files, (loaded) => this.#openLoaded(loaded));
      return;
    }
    const choice = await dialogs.dropChoice(files.length, hasImage);
    if (choice === undefined) return;
    if (choice === "open") {
      await this.#transfer(files, (loaded) => this.#openLoaded(loaded));
      return;
    }
    const target = tabs.active?.id ?? this.#openBlankImage();
    await this.#transfer(files, (loaded) => this.#importLoaded(target, loaded));
  }

  /**
   * File > Print (FMT-PRN-01, WEB-PRN-01). The flattened image goes to the print view, fit to the
   * page or at its real size, and the browser prints it. The document does not change. Without a
   * print, or when the flattened image cannot be allocated, the user is told why.
   */
  async printActive(): Promise<void> {
    const { tabs, dialogs, printer, notify, t } = this.#options;
    const image = tabs.active?.value;
    if (image === undefined) return;
    if (!printer.available()) {
      notify(t("print.unavailable"));
      return;
    }
    const mode = await dialogs.printChoice();
    if (mode === undefined) return;
    const { document } = image;
    const size: Size = { width: document.width, height: document.height };
    let src: string | undefined;
    try {
      src = allocateWithBudget(newDocumentAccountant(), size.width * size.height * 4, () =>
        printer.encode(document.composite()),
      );
    } catch (error) {
      if (!(error instanceof OutOfMemoryError)) throw error;
    }
    if (src === undefined) {
      notify(t("print.outOfMemory"));
      return;
    }
    await printer.print({
      src,
      alt: image.name,
      layout: printLayout(size, document.resolution, mode),
    });
  }

  /** The file types whose codec failed to load this session, with the codec's error (FMT-REG-01). */
  unavailableCodecs(): readonly { readonly name: string; readonly error: string }[] {
    const { registry, t } = this.#options;
    return [...this.#unavailable].map(([id, { cause }]) => {
      const type = registry.get(id);
      return {
        name: type === undefined ? id : t(type.label),
        error: cause instanceof Error ? cause.message : String(cause),
      };
    });
  }

  /** Save or Save As for the active image. Does nothing with no image open. */
  async saveActive(saveAs: boolean): Promise<void> {
    const active = this.#options.tabs.active;
    if (active !== undefined) await this.save(active.id, saveAs);
  }

  /** Save All (FMT-SAVE-01): saves every image with unsaved changes, one after another. */
  async saveAll(): Promise<void> {
    const dirty = this.#options.tabs.state.items
      .filter((item) => item.value.document.dirty)
      .map((item) => item.id);
    await this.saveImages(dirty);
  }

  /**
   * Saves the listed images in order, and stops at the first one that is not saved. Resolves to
   * whether every one was saved, so the Unsaved Changes dialog only closes images once they are safe.
   */
  async saveImages(ids: readonly string[]): Promise<boolean> {
    for (const id of ids) {
      if (this.#options.tabs.get(id)?.value.document.dirty !== true) continue;
      if ((await this.save(id, false)) !== "saved") return false;
    }
    return true;
  }

  /**
   * Save writes back to the image's handle when it has one and its type can save (FMT-SAVE-01).
   * Otherwise, and for Save As, the user picks where to save.
   */
  async save(id: string, saveAs: boolean): Promise<SaveOutcome> {
    // An engine v2 stroke still being read back is part of what the user saves.
    await engineStrokesSettled();
    const image = this.#options.tabs.get(id)?.value;
    if (image === undefined) return "canceled";
    const file = image.file;
    const type =
      file === undefined
        ? undefined
        : this.#savable().find((candidate) => candidate.id === file.typeId);
    const handle = file?.handle;
    if (!saveAs && handle !== undefined && type !== undefined) {
      return this.#finish(id, type, { name: image.name, handle }, false);
    }
    return this.#saveAs(id, image);
  }

  async #saveAs(id: string, image: OpenImage): Promise<SaveOutcome> {
    const { access, dialogs, t } = this.#options;
    const savable = this.#savable();
    const current = savable.find((type) => type.id === image.file?.typeId);
    const selected = current ?? savable[0];
    if (selected === undefined) return "canceled";
    const types = [selected, ...savable.filter((type) => type !== selected)];
    const proposal = suggestedName(image.name, selected);

    if (access.canPickSaveTarget) {
      const target = await access.pickSaveTarget(proposal, savePickerTypes(types, t));
      if (target === undefined) return "canceled";
      const type = typeOfName(target.name, types, selected);
      return this.#finish(id, type, { name: target.name, handle: target.handle }, true);
    }

    const choice = await dialogs.saveName(
      proposal,
      types.map((type) => ({ id: type.id, label: t(type.label) })),
      selected.id,
    );
    if (choice === undefined) return "canceled";
    const chosen = types.find((type) => type.id === choice.typeId) ?? selected;
    const resolved = resolveDownloadName(choice.name, types, chosen);
    return this.#finish(id, resolved.type, { name: resolved.name }, true);
  }

  /**
   * The steps after the target is known. Save Configuration comes first when the type has options
   * and the save asks for them (FMT-UI-01), so a canceled dialog changes nothing. Then comes the
   * flatten prompt (FMT-SAVE-02), and then the write.
   */
  async #finish(
    id: string,
    type: FileTypeDescriptor,
    target: { readonly name: string; readonly handle?: FileSystemFileHandle | undefined },
    configure: boolean,
  ): Promise<SaveOutcome> {
    const { tabs, dialogs, notify, t } = this.#options;
    const image = tabs.get(id)?.value;
    if (image === undefined) return "canceled";
    let values = this.#rememberedValues(type);
    let encoded: Uint8Array<ArrayBuffer> | undefined;
    if (configure && hasSaveOptions(type)) {
      let codec: FileCodec;
      try {
        codec = await this.#codec(type);
      } catch (error) {
        notify(failureText(saveFailure(error, "encode"), t));
        return "failed";
      }
      const choice: SaveConfigChoice | undefined = await dialogs.configureSave({
        type,
        codec,
        file: flatFileDocument(image.document),
        values,
      });
      if (choice === undefined) return "canceled";
      values = choice.values;
      encoded = choice.encoded;
    }
    if (!(await this.#flatten(id, type))) return "canceled";
    return this.#write(id, type, target, values, encoded);
  }

  /** Flattens a multi-layer image for a type without layers, as one undoable step (FMT-SAVE-02). */
  async #flatten(id: string, type: FileTypeDescriptor): Promise<boolean> {
    const { tabs, dialogs } = this.#options;
    const document = tabs.get(id)?.value.document;
    if (document === undefined) return false;
    if (document.layerCount > 1 && !type.capabilities.supportsLayers) {
      const flatten = await dialogs.flatten();
      if (!flatten || tabs.get(id) === undefined) return false;
      document.flatten();
    }
    return true;
  }

  /** The options a save starts from: the remembered values, or the schema defaults (FMT-UI-01). */
  #rememberedValues(type: FileTypeDescriptor): PropertyValues {
    return new PropertyCollection(
      type.saveOptions,
      this.#options.saveConfig.load(type.id),
    ).values();
  }

  /**
   * Encodes the image completely in memory, and only then writes it (FMT-SAVE-03). A failed encode
   * or write leaves the file as it was. Bytes the Save Configuration preview already encoded for
   * these values are written as they are (FMT-UI-03).
   */
  async #write(
    id: string,
    type: FileTypeDescriptor,
    target: { readonly name: string; readonly handle?: FileSystemFileHandle | undefined },
    values: PropertyValues,
    reused: Uint8Array<ArrayBuffer> | undefined,
  ): Promise<SaveOutcome> {
    const { tabs, dialogs, access, notify, t } = this.#options;
    const before = tabs.get(id)?.value;
    if (before === undefined) return "canceled";
    const document = before.document;

    dialogs.show({ kind: "saving" });
    let phase: "encode" | "write" = "encode";
    try {
      const encoded =
        reused ??
        (await encode(await this.#codec(type), document, values, type.capabilities.supportsLayers));
      phase = "write";
      if (target.handle === undefined) {
        access.download(target.name, type.mimeTypes[0] ?? "application/octet-stream", encoded);
      } else {
        await access.ensureWritable(target.handle);
        await access.write(target.handle, encoded);
      }
    } catch (error) {
      dialogs.close();
      notify(failureText(saveFailure(error, phase), t));
      return "failed";
    }
    dialogs.close();

    tabs.replace(id, {
      ...before,
      name: target.name,
      file: { typeId: type.id, handle: target.handle },
    });
    document.markClean();
    if (hasSaveOptions(type)) this.#options.saveConfig.store(type.id, values);
    this.#remember(target.name, target.handle, document);
    return "saved";
  }

  /**
   * Loads each file in turn, with the Transferring dialog (FMT-OPEN-03), and hands it to `place`.
   * A file that fails asks Retry, Skip or Cancel. Cancel stops the rest.
   */
  async #transfer(
    files: readonly OpenedFile[],
    place: (loaded: LoadedImage) => void | Promise<void>,
  ): Promise<void> {
    const { dialogs, report, t } = this.#options;
    let canceled = false;
    let position = 0;
    const progress = (canceling: boolean): FileDialogRequest => ({
      kind: "transfer",
      index: position + 1,
      total: files.length,
      canceling,
      cancel,
    });
    const cancel = (): void => {
      canceled = true;
      dialogs.show(progress(true));
    };

    for (const [index, file] of files.entries()) {
      if (canceled) break;
      position = index;
      for (;;) {
        dialogs.show(progress(false));
        try {
          const loaded = await this.#load(file);
          if (canceled || loaded === undefined) break;
          await place(loaded);
          break;
        } catch (error) {
          if (canceled) break;
          const message = openFailure(error);
          if (message.id === "file.error.unknown") report(error);
          const choice = await dialogs.transferError(
            t("file.transferError.text", { error: failureText(message, t) }),
          );
          if (choice === "retry") continue;
          if (choice === "cancel") canceled = true;
          break;
        }
      }
    }
    dialogs.close();
  }

  /**
   * The opened image, and the catalog keys of the warnings its load raised (FMT-META-03). A layered
   * file with damaged layers asks first (FMT-NAT-09). Resolves to undefined when the user declines.
   */
  async #load(file: OpenedFile): Promise<LoadedImage | undefined> {
    const bytes = await file.bytes();
    const declared = findOpenFileType(this.#options.registry, extensionOf(file.name));
    const sniffed = sniffFileType(this.#loadable(), bytes);
    const candidates = [declared, sniffed]
      .filter((type): type is FileTypeDescriptor => type !== undefined)
      .filter((type, index, all) => all.findIndex((other) => other.id === type.id) === index);
    if (candidates.length === 0) throw new UnrecognizedFileError(file.name);

    let failure: unknown;
    for (const type of candidates) {
      let decoded: FileDocument;
      try {
        const codec = await this.#codec(type);
        decoded = await codec.load({ byteLength: bytes.byteLength, readAll: async () => bytes });
      } catch (error) {
        if (error instanceof CodecUnavailableError || error instanceof OutOfMemoryError)
          throw error;
        failure ??= error;
        continue;
      }
      if (decoded.layers.some((layer) => layer.damaged === true)) {
        if (!(await this.#options.dialogs.recoverLayers())) return undefined;
      }
      return {
        image: {
          name: file.name,
          document: documentFromFile(decoded),
          file: { typeId: type.id, handle: file.handle },
        },
        warnings: decoded.warnings ?? [],
      };
    }
    throw failure;
  }

  /**
   * The codec of a type, loaded once. A codec that fails to load takes its type out of the lists
   * for the rest of the session (FMT-REG-01).
   */
  async #codec(type: FileTypeDescriptor): Promise<FileCodec> {
    const failed = this.#unavailable.get(type.id);
    if (failed !== undefined) throw new CodecUnavailableError(failed.cause);
    let pending = this.#codecs.get(type.id);
    if (pending === undefined) {
      pending = type.loadCodec();
      this.#codecs.set(type.id, pending);
    }
    try {
      return await pending;
    } catch (cause) {
      this.#codecs.delete(type.id);
      this.#unavailable.set(type.id, { cause });
      throw new CodecUnavailableError(cause);
    }
  }

  #loadable(): FileTypeDescriptor[] {
    return openFileTypes(this.#options.registry).filter((type) => !this.#unavailable.has(type.id));
  }

  #savable(): FileTypeDescriptor[] {
    return saveFileTypes(this.#options.registry).filter((type) => !this.#unavailable.has(type.id));
  }

  /** Adds a loaded image as a tab, with its Open Recent entry and its load warnings (FMT-META-03). */
  #openLoaded({ image, warnings }: LoadedImage): void {
    const { notify, openImage, t } = this.#options;
    openImage(image);
    this.#remember(image.name, image.file?.handle, image.document);
    for (const key of warnings) notify(t(key as MessageId));
  }

  /**
   * Adds a loaded image to the image `id` as one new layer (DOC-LYR-05e). The layer is named after
   * the file and its layer, and the image is composited, so a layered file becomes one layer. An
   * image larger than the canvas asks about the canvas first. Cancel adds nothing.
   */
  async #importLoaded(id: string, { image, warnings }: LoadedImage): Promise<void> {
    const { tabs, dialogs, notify, t } = this.#options;
    const source = image.document;
    try {
      const target = tabs.get(id)?.value;
      if (target === undefined) return;
      const canvas: Size = { width: target.document.width, height: target.document.height };
      const pixels = source.composite();
      const size: Size = { width: pixels.width, height: pixels.height };
      let expandTo: Size | undefined;
      if (pasteExceedsCanvas(canvas, size)) {
        const choice = await dialogs.importSize();
        if (choice === "cancel") return;
        if (choice === "expand") expandTo = expandedCanvasSize(canvas, size);
      }
      const current = tabs.get(id)?.value;
      if (current === undefined) return;
      const sourceLayer = source.layerCount === 1 ? source.layers[0]?.name : undefined;
      current.document.importLayer(
        t("layers.importName", {
          file: image.name,
          layer: sourceLayer ?? t("layers.importComposite"),
        }),
        pixels,
        expandTo === undefined ? {} : { expandTo },
      );
    } finally {
      source.dispose();
    }
    for (const key of warnings) notify(t(key as MessageId));
  }

  /** Creates a blank image at the default new-image size (DOC-NEW-01) and opens it. Returns its id. */
  #openBlankImage(): string {
    const { newImageSize, openImage, t, tabs } = this.#options;
    const size = newImageSize();
    const image: OpenImage = {
      name: t("document.untitled"),
      document: Document.createBlank({
        width: size.width,
        height: size.height,
        accountant: newDocumentAccountant(),
      }),
    };
    openImage(image);
    const id = tabs.state.items.find((item) => item.value === image)?.id;
    if (id === undefined) throw new Error("The new image did not open.");
    return id;
  }

  /** Fetches the images dragged from other pages (WEB-FILE-06). An address that cannot be read is reported and skipped. */
  async #fetchRemote(urls: readonly string[]): Promise<OpenedFile[]> {
    const { notify, registry, t } = this.#options;
    const files: OpenedFile[] = [];
    for (const url of urls) {
      try {
        const fetched = await fetchDroppedImage(url);
        const name = remoteFileName(url, fetched.contentType, openFileTypes(registry));
        files.push({ name, bytes: async () => fetched.bytes });
      } catch {
        notify(failureText({ id: "file.error.remote" }, t));
      }
    }
    return files;
  }

  #remember(name: string, handle: FileSystemFileHandle | undefined, document: Document): void {
    const scale = this.#options.devicePixelRatio();
    this.#options.recent.add({
      name,
      handle,
      thumbnail: this.#options.thumbnail(document, Math.round(RECENT_THUMBNAIL_SIZE * scale)),
      thumbnailScale: scale,
    });
  }
}

/**
 * The document an opened file describes. A flat file's one layer becomes the Background (FMT-OPEN-01).
 * A layered file keeps its layers, selection, active layer and unknown keys (FMT-NAT-11). A file that
 * changed on load opens with unsaved changes (FMT-NAT-07).
 */
export function documentFromFile(file: FileDocument): Document {
  const single = file.layers.length === 1;
  const document = Document.fromLayers(
    file.width,
    file.height,
    file.layers.map((layer) => ({
      pixels: layer.surface,
      name: layer.name,
      visible: layer.visible,
      opacity: layer.opacity,
      blendMode: layer.blendMode as LayerBlendMode,
      ...(layer.rawBlendMode === undefined ? {} : { rawBlendMode: layer.rawBlendMode }),
      isBackground: layer.isBackground ?? single,
      ...(layer.metadata === undefined ? {} : { metadata: layer.metadata }),
      ...(layer.extras === undefined ? {} : { extras: layer.extras }),
    })),
    {
      resolution: file.resolution,
      colorProfile: file.colorProfile,
      accountant: newDocumentAccountant(),
      formatExtras: file.extras ?? {},
      ...(file.selection === undefined ? {} : { selection: file.selection }),
      ...(file.activeLayer === undefined ? {} : { activeIndex: file.activeLayer }),
    },
  );
  if (file.dirty === true) document.markUnsaved();
  if (file.metadata.exif !== undefined) document.metadata.exif.set("exif", file.metadata.exif);
  for (const [index, packet] of file.metadata.xmp.entries()) {
    document.metadata.xmp.set(String(index), packet);
  }
  if (file.metadata.iptc !== undefined) document.metadata.iptc.set("iptc", file.metadata.iptc);
  for (const [name, value] of Object.entries(file.metadata.user)) {
    document.metadata.user.set(name, value);
  }
  return document;
}

/**
 * The metadata a flat file writes: the first EXIF block, every XMP packet, the first IPTC block and
 * the user items (FMT-META-05). A format that has no field for a section ignores it.
 */
function flatMetadata(document: Document): FileDocument["metadata"] {
  const exif = firstBinary(document.metadata.exif.entries());
  const iptc = firstBinary(document.metadata.iptc.entries());
  const xmp = [...document.metadata.xmp.entries()]
    .map(([, value]) => value)
    .filter((value): value is string => typeof value === "string");
  const user = Object.fromEntries(document.metadata.user.entries());
  return {
    ...(exif === undefined ? {} : { exif }),
    xmp,
    ...(iptc === undefined ? {} : { iptc }),
    user,
  };
}

function firstBinary(entries: Iterable<[string, unknown]>): Uint8Array | undefined {
  for (const [, value] of entries) {
    if (value instanceof Uint8Array) return value;
  }
  return undefined;
}

/** Whether a type has save options, and so a Save Configuration dialog (FMT-UI-01). */
export function hasSaveOptions(type: FileTypeDescriptor): boolean {
  return type.saveOptions.properties.length > 0;
}

/**
 * The document as one flat image: its visible layers composited over the canvas (FMT-SAVE-06).
 * Flat formats have no layers, so the composite is the only layer they write.
 */
export function flatFileDocument(document: Document): FileDocument {
  return {
    width: document.width,
    height: document.height,
    resolution: document.resolution,
    colorProfile: document.colorProfile,
    metadata: flatMetadata(document),
    layers: [
      {
        name: FLAT_LAYER_NAME,
        visible: true,
        opacity: 255,
        blendMode: 0,
        surface: document.composite(),
      },
    ],
  };
}

/** The edge of the preview a layered file stores (FMT-NAT-06). */
const THUMBNAIL_MAX_SIZE = 256;

/**
 * The document as a layered file (FMT-NAT-11): every layer with its pixels and properties, the
 * selection, the active layer, the unknown keys of the format, and a preview thumbnail.
 */
export function layeredFileDocument(document: Document): FileDocument {
  const area = rect(0, 0, document.width, document.height);
  const selection = document.selection;
  const active = document.activeLayer;
  return {
    width: document.width,
    height: document.height,
    resolution: document.resolution,
    colorProfile: document.colorProfile,
    metadata: flatMetadata(document),
    layers: document.layers.map((layer) => ({
      name: layer.name,
      visible: layer.visible,
      opacity: layer.opacity,
      blendMode: layer.blendMode,
      surface: layer.pixels.readRegion(area),
      isBackground: layer.isBackground,
      metadata: Object.fromEntries(layer.metadata.entries()),
      ...(layer.rawBlendMode === undefined ? {} : { rawBlendMode: layer.rawBlendMode }),
      extras: layer.extras,
    })),
    ...(selection.isEmpty
      ? {}
      : { selection: { polygons: selection.effectivePolygons(), quality: selection.quality } }),
    activeLayer: active === undefined ? 0 : Math.max(0, document.layers.indexOf(active)),
    extras: document.formatExtras,
    thumbnail: documentThumbnail(document, THUMBNAIL_MAX_SIZE),
  };
}

/**
 * Encodes the document with the given save options. A layered type gets every layer, and a flat one
 * the flattened image. The bytes are collected so the caller can write them in one step.
 */
async function encode(
  codec: FileCodec,
  document: Document,
  values: PropertyValues,
  layered: boolean,
): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  await codec.save(
    layered ? layeredFileDocument(document) : flatFileDocument(document),
    {
      write: async (chunk) => {
        parts.push(new Uint8Array(chunk));
      },
    },
    values,
    () => undefined,
  );
  const out = new Uint8Array(
    new ArrayBuffer(parts.reduce((sum, part) => sum + part.byteLength, 0)),
  );
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
