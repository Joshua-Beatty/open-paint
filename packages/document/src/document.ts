import { type MessageId, t } from "@openpaint/i18n";
import { LayerBlendMode } from "./blend-mode";
import {
  applyMetadataJson,
  CHECKPOINT_FORMAT,
  CHECKPOINT_VERSION,
  CheckpointError,
  type CheckpointItem,
  type CheckpointLayer,
  type CheckpointSnapshot,
  type DocumentCheckpoint,
  type DocumentCheckpointManifest,
  decodeJson,
  encodeJson,
  historyBlobName,
  type LayerInfo,
  layerRowBlobName,
  metadataEntries,
  metadataJson,
  selectionFromJson,
  selectionJson,
} from "./checkpoint";
import {
  ClipboardError,
  type ClipboardImage,
  imageOutline,
  type PasteOptions,
  pasteArea,
  pasteContent,
  pasteReplace,
  translatePolygons,
} from "./clipboard";
import { type ColorRgba8, TRANSPARENT, WHITE } from "./color";
import type { FloatingContent } from "./coverage-place";
import type { LayerFloatPreview } from "./float-preview";
import type { FormatExtras } from "./format-extras";
import { intersectRects, isEmptyRect, type Point, type Rect, rect, type Size } from "./geometry";
import {
  BUSY_MESSAGE,
  compoundCommand,
  History,
  type HistoryCommand,
  placeholderCommand,
} from "./history/history";
import { MemorySpillStorage } from "./history/memory-spill-storage";
import { type SpillHandle, SpillStore } from "./history/spill-store";
import {
  captureTiles,
  captureTilesBefore,
  type EarlierTiles,
  restoreTiles,
} from "./history/tile-patch";
import {
  type CanvasAnchor,
  canvasOffset,
  flipMatrix,
  type ImageAxis,
  type ImageRotation,
  rotatedSize,
  rotationMatrix,
} from "./image-transform";
import { type JobControl, throwIfCanceled } from "./job";
import {
  DEFAULT_LAYER_OPACITY,
  Layer,
  type LayerInit,
  type LayerLivePreview,
  type LayerProperties,
} from "./layer";
import {
  cloneLayerPixels,
  compositeLayerPixels,
  flattenLayerPixels,
  flattenRegion,
  mirrorLayerPixels,
  placeLayerPixels,
  resampleLayerPixels,
  resampleLayerPixelsWith,
  rotateLayerPixels,
} from "./layer-pixels";
import { isValidImageSize } from "./limits";
import { MemoryAccountant, type MemoryOperation, OutOfMemoryError } from "./memory";
import { MetadataStore } from "./metadata";
import { FloatingPixels, remainingAfterLift } from "./pixel-float";
import type { ColorProfileId } from "./pixel-format";
import type { ResampleOptions } from "./resample";
import { DEFAULT_RESOLUTION, isValidResolution, type Resolution } from "./resolution";
import { Selection } from "./selection";
import { clipAlphaToCoverage, overwriteSelection } from "./selection-pixels";
import {
  IDENTITY_AFFINE,
  rectPolygon,
  type SelectionCombineMode,
  type SelectionPolygon,
  type SelectionQuality,
} from "./selection-polygons";
import { Surface } from "./surface";
import { TILE_SIZE, TiledPixelStore } from "./tiled-store";

/** DOC-DOC-07: the initial layer name. */
export const BACKGROUND_LAYER_NAME = "Background";

/** WEB-MEM-03: the worst-case bytes of `layers` stores of `width` x `height`, counted in whole tiles. */
function layersBytes(width: number, height: number, layers: number): number {
  return layers * TiledPixelStore.estimateBytes(width, height);
}

/** DOC-LYR-03: the name of a new blank layer, given the layer count before the add. */
export function defaultLayerName(layerCountBeforeAdd: number): string {
  return `Layer ${layerCountBeforeAdd + 1}`;
}

export interface DocumentOptions {
  readonly width: number;
  readonly height: number;
  readonly resolution?: Resolution;
  readonly colorProfile?: ColorProfileId;
  /** Shared pixel budget; a private default-budget accountant otherwise (WEB-MEM-03). */
  readonly accountant?: MemoryAccountant;
  /** Where undo data is spilled. Defaults to a volatile in-memory storage owned by the document. */
  readonly spill?: SpillStore;
  /** Keys a file format did not recognize, kept for the next save (FMT-NAT-07). */
  readonly formatExtras?: FormatExtras;
}

/** One layer of a document opened from a file. `pixels` must match the canvas size. */
export interface LayerSource {
  readonly pixels: Surface;
  readonly name: string;
  readonly visible: boolean;
  readonly opacity: number;
  readonly blendMode: LayerBlendMode;
  readonly rawBlendMode?: number;
  readonly isBackground: boolean;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly extras?: Readonly<Record<string, unknown>>;
}

/** Options of `Document.fromLayers`: the document options and the file's selection and active layer. */
export interface LayeredDocumentOptions extends Omit<DocumentOptions, "width" | "height"> {
  readonly selection?: {
    readonly polygons: readonly SelectionPolygon[];
    readonly quality: SelectionQuality;
  };
  /** Index of the active layer. Defaults to the top layer. */
  readonly activeIndex?: number;
}

export type LayerErrorReason = "last-layer" | "no-layer-below" | "no-active-layer";

/** A layer command that the document's rules refuse (DOC-LYR-04, DOC-LYR-05b/d). */
export class LayerError extends Error {
  override readonly name = "LayerError";

  constructor(
    readonly reason: LayerErrorReason,
    message: string,
  ) {
    super(message);
  }
}

const PROPERTY_LABELS: Record<keyof LayerProperties, MessageId> = {
  name: "history.property.name",
  visible: "history.property.visible",
  opacity: "history.property.opacity",
  blendMode: "history.property.blendMode",
};

/** One layer in a history snapshot. `pixels` is undefined when the layer keeps its current pixels. */
interface LayerSnapshot {
  readonly layer: Layer;
  readonly properties: LayerProperties;
  readonly metadata: readonly (readonly [string, string])[];
  readonly pixels: SpillHandle | undefined;
}

/** The state a history item restores (DOC-HIS-02). Pixels are spilled only where they change. */
interface DocumentSnapshot {
  readonly width: number;
  readonly height: number;
  readonly layers: readonly LayerSnapshot[];
  readonly activeLayer: Layer | undefined;
  readonly selection: Selection;
  readonly resolution: Resolution;
}

/** What a history item restores. Checkpoints write it out and rebuild it (WEB-MEM-05). */
type ItemData =
  | {
      readonly kind: "snapshot";
      readonly before: DocumentSnapshot;
      readonly after: DocumentSnapshot;
    }
  | {
      readonly kind: "pixels";
      readonly layer: Layer;
      readonly beforePatch: SpillHandle;
      readonly afterPatch: SpillHandle;
      readonly selectionBefore: Selection;
      readonly selectionAfter: Selection;
    };

/**
 * A raster document (DOC-DOC): fixed pixel size, resolution, metadata, an ordered layer list
 * (bottom to top) with one active layer, and a linear undo history. Every change through the
 * methods below is recorded as one history item (DOC-HIS-03). The dirty flag follows the saved
 * position of that history (DOC-DOC-06).
 */
export class Document {
  readonly colorProfile: ColorProfileId;
  readonly accountant: MemoryAccountant;
  readonly metadata = new MetadataStore();
  readonly history: History;
  /** Keys a file format did not recognize, written back on save (FMT-NAT-07). */
  readonly formatExtras: FormatExtras;
  readonly #spill: SpillStore;
  #width: number;
  #height: number;
  #resolution: Resolution;
  #layers: Layer[] = [];
  #active: Layer | undefined;
  #nextLayerId = 1;
  #selection = new Selection();
  readonly #listeners = new Set<(change: DocumentChange) => void>();
  readonly #items = new WeakMap<HistoryCommand, ItemData>();

  constructor(options: DocumentOptions, historyBase?: string) {
    if (!isValidImageSize(options.width, options.height)) {
      throw new RangeError(`Invalid image size ${options.width}x${options.height}.`);
    }
    const resolution = options.resolution ?? DEFAULT_RESOLUTION;
    if (!isValidResolution(resolution)) throw new RangeError("Invalid resolution.");
    this.#width = options.width;
    this.#height = options.height;
    this.#resolution = resolution;
    this.colorProfile = options.colorProfile ?? "srgb";
    this.formatExtras = options.formatExtras ?? {};
    this.accountant = options.accountant ?? new MemoryAccountant();
    this.#spill = options.spill ?? new SpillStore({ storage: new MemorySpillStorage() });
    this.history = new History(historyBase);
    this.history.subscribe(() => {
      this.#notify();
    });
  }

  /** DOC-DOC-07: a document with one opaque white "Background" layer and a clean dirty flag. */
  static createBlank(options: DocumentOptions): Document {
    const doc = new Document(options, t("history.newImage"));
    try {
      doc.#preflight(TiledPixelStore.estimateBytes(options.width, options.height), "newImage");
      const pixels = doc.#newPixels();
      try {
        pixels.fill(WHITE);
      } catch (error) {
        pixels.dispose();
        throw error;
      }
      doc.#insert(doc.#makeLayer(pixels, BACKGROUND_LAYER_NAME, true), 0);
      doc.#active = doc.#layers[0];
    } catch (error) {
      doc.dispose();
      throw error;
    }
    return doc;
  }

  /**
   * DOC-CLP-01g: a document sized to `image`, with one "Background" layer holding its pixels.
   * Transparent pixels stay transparent, and the history starts at "Paste into New Image".
   */
  static fromClipboardImage(
    image: ClipboardImage,
    options: Omit<DocumentOptions, "width" | "height"> = {},
  ): Document {
    return Document.#fromPixels(image.pixels, options, t("history.pasteIntoNewImage"), "paste");
  }

  /**
   * A document with the given layers, bottom to top, for a file that stores several (FMT-NAT-11).
   * The history starts at "Open", and the document starts clean. `options.selection` is set without
   * a history item, and the active layer is the top one unless `activeIndex` names another.
   */
  static fromLayers(
    width: number,
    height: number,
    layers: readonly LayerSource[],
    options: LayeredDocumentOptions = {},
  ): Document {
    if (layers.length === 0) throw new RangeError("A document needs at least one layer.");
    const { selection, activeIndex, ...base } = options;
    const doc = new Document({ ...base, width, height }, t("history.open"));
    try {
      doc.#preflight(layers.length * TiledPixelStore.estimateBytes(width, height), "newImage");
      for (const [index, source] of layers.entries()) {
        if (source.pixels.width !== width || source.pixels.height !== height) {
          throw new RangeError(`Layer ${index} does not match the canvas size.`);
        }
        const store = doc.#newPixels();
        try {
          store.writeRegion(source.pixels, 0, 0);
        } catch (error) {
          store.dispose();
          throw error;
        }
        const layer = doc.#makeLayer(store, source.name, source.isBackground, {
          visible: source.visible,
          opacity: source.opacity,
          blendMode: source.blendMode,
          rawBlendMode: source.rawBlendMode,
          extras: source.extras,
        });
        for (const [name, value] of Object.entries(source.metadata ?? {})) {
          layer.metadata.set(name, value);
        }
        doc.#insert(layer, index);
      }
      const active = activeIndex ?? layers.length - 1;
      doc.#active = doc.#layers[Math.min(Math.max(active, 0), layers.length - 1)];
      if (selection !== undefined && selection.polygons.length > 0) {
        doc.#selection = new Selection(selection.polygons, selection.quality);
      }
    } catch (error) {
      doc.dispose();
      throw error;
    }
    return doc;
  }

  /**
   * A document sized to `pixels`, with one "Background" layer holding them, for an image opened
   * from a file (FMT-OPEN-01). The history starts at "Open".
   */
  static fromSurface(
    pixels: Surface,
    options: Omit<DocumentOptions, "width" | "height"> = {},
  ): Document {
    return Document.#fromPixels(pixels, options, t("history.open"), "newImage");
  }

  static #fromPixels(
    pixels: Surface,
    options: Omit<DocumentOptions, "width" | "height">,
    historyBase: string,
    operation: MemoryOperation,
  ): Document {
    const doc = new Document(
      { ...options, width: pixels.width, height: pixels.height },
      historyBase,
    );
    try {
      doc.#preflight(TiledPixelStore.estimateBytes(pixels.width, pixels.height), operation);
      const store = doc.#newPixels();
      try {
        store.writeRegion(pixels, 0, 0);
      } catch (error) {
        store.dispose();
        throw error;
      }
      doc.#insert(doc.#makeLayer(store, BACKGROUND_LAYER_NAME, true), 0);
      doc.#active = doc.#layers[0];
    } catch (error) {
      doc.dispose();
      throw error;
    }
    return doc;
  }

  /**
   * The visible layers composited over the whole canvas, with blend modes and opacity (FMT-SAVE-06).
   * Hidden layers are left out, and the selection does not clip the result.
   */
  composite(): Surface {
    return this.compositeArea(rect(0, 0, this.#width, this.#height));
  }

  /**
   * The visible layers composited over `area` only, as `composite()` does over the whole canvas. The
   * area is expected to lie inside the canvas (TL-PICK-01 samples the merged image this way).
   */
  compositeArea(area: Rect): Surface {
    return flattenRegion(
      this.#layers.filter((layer) => layer.visible),
      area,
    );
  }

  get width(): number {
    return this.#width;
  }

  get height(): number {
    return this.#height;
  }

  get resolution(): Resolution {
    return this.#resolution;
  }

  /** Sets the resolution, which must be valid for its unit (DOC-DOC-03). Recorded as "Resize". */
  setResolution(resolution: Resolution): void {
    if (!isValidResolution(resolution)) throw new RangeError("Invalid resolution.");
    if (sameResolution(resolution, this.#resolution)) return;
    this.#editState(t("history.resize"), () => {
      this.#resolution = resolution;
    });
  }

  /** Layers from bottom to top. */
  get layers(): readonly Layer[] {
    return this.#layers;
  }

  get layerCount(): number {
    return this.#layers.length;
  }

  get activeLayer(): Layer | undefined {
    return this.#active;
  }

  /** Selects a layer for later commands. Activation is not a history item (DOC-LYR-05p). */
  setActiveLayer(layer: Layer): void {
    if (!this.#layers.includes(layer)) throw new RangeError("The layer is not in this document.");
    this.#active = layer;
    this.#notify();
  }

  /** The document selection (DOC-SEL). Immutable, so a previous value stays valid. */
  get selection(): Selection {
    return this.#selection;
  }

  /** DOC-SEL-06a: selects the whole canvas. */
  selectAll(): void {
    this.#editSelection(t("history.selectAll"), Selection.all(this, this.#selection.quality));
  }

  /** DOC-SEL-06b: clears the selection. Does nothing when nothing is selected. */
  deselect(): void {
    if (this.#selection.isEmpty) return;
    this.#editSelection(t("history.deselect"), new Selection([], this.#selection.quality));
  }

  /**
   * DOC-SEL-06c: selects the canvas minus the current selection. Refused when nothing is selected,
   * since the command is disabled then. Returns whether it ran.
   */
  invertSelection(): boolean {
    if (this.#selection.isEmpty) return false;
    this.#editSelection(t("history.invertSelection"), this.#selection.inverted(this));
    return true;
  }

  /**
   * DOC-SEL-06d: sets the selected pixels of the active layer to transparent, then deselects. With
   * nothing selected it clears the whole layer. One history item.
   */
  eraseSelection(): void {
    this.#erase(t("history.eraseSelection"));
  }

  /**
   * DOC-CLP-01b/c: the pixels inside the selection's bounds, with alpha clipped to the selection's
   * coverage. Copies the active layer, or the visible layers composited when `merged` is set. With
   * nothing selected the whole canvas is copied. Returns undefined when the area is empty.
   */
  copyPixels(merged: boolean): ClipboardImage | undefined {
    const area = this.#editArea();
    if (isEmptyRect(area)) return undefined;
    const selection = this.#selection;
    try {
      const pixels = merged
        ? flattenRegion(
            this.#layers.filter((layer) => layer.visible),
            area,
          )
        : this.#requireActive().pixels.readRegion(area);
      if (selection.isEmpty) return { pixels, origin: { x: area.x, y: area.y } };
      clipAlphaToCoverage(pixels, selection.mask(area));
      return {
        pixels,
        origin: { x: area.x, y: area.y },
        outline: translatePolygons(selection.effectivePolygons(), -area.x, -area.y),
      };
    } catch (error) {
      if (error instanceof OutOfMemoryError) throw new ClipboardError("clipboard.outOfMemory");
      throw error;
    }
  }

  /** DOC-CLP-01a: copies the active layer as Copy does, then erases the same pixels as "Cut". */
  cutSelection(): ClipboardImage | undefined {
    const copied = this.copyPixels(false);
    if (copied) this.#erase(t("history.cut"));
    return copied;
  }

  /**
   * DOC-CLP-01e/f and DOC-CLP-05: pastes `image` with its top-left at `at`. Inside the pasted
   * outline the pixels replace those of the active layer, transparency included, as Move Selected
   * Pixels places them (TL-MOVE-PIX-01), or they go on a new layer with `newLayer`. The selection
   * becomes the pasted outline. `expandTo` grows the canvas first, anchored top-left with
   * transparent fill, and that growth and the paste form one "Canvas Size" item.
   */
  pasteImage(image: ClipboardImage, at: Point, options: PasteOptions = {}): void {
    this.#paste(image, at, options, pasteContent(image, this.#selection.quality));
  }

  #paste(image: ClipboardImage, at: Point, options: PasteOptions, content: FloatingContent): void {
    this.history.assertIdle();
    const current: Size = { width: this.#width, height: this.#height };
    const size = options.expandTo ?? current;
    if (size.width < current.width || size.height < current.height) {
      throw new RangeError("A paste can only expand the canvas.");
    }
    if (!isValidImageSize(size.width, size.height)) {
      throw new RangeError(`Invalid image size ${size.width}x${size.height}.`);
    }
    const selection = new Selection(
      translatePolygons(imageOutline(image), at.x, at.y),
      this.#selection.quality,
    );
    const target = this.#requireActive();
    const grows = size.width !== current.width || size.height !== current.height;
    this.#preflight(this.#pasteBytes(image, size, grows, options.newLayer === true), "paste");
    if (!grows && !options.newLayer) {
      const area = pasteArea(image.pixels, at, rect(0, 0, this.#width, this.#height));
      this.#editPixels(
        t("history.paste"),
        target,
        area,
        (pixels) => {
          pasteReplace(pixels, content, at);
        },
        selection,
      );
      return;
    }
    const pasted = options.newLayer ? this.#pastedPixels(size, content, at) : undefined;
    try {
      this.#transact(
        grows ? t("history.canvasSize") : t("history.pasteIntoNewLayer"),
        grows ? [...this.#layers] : [],
        () => {
          if (grows) {
            const paste = pasted ? undefined : { content, at };
            this.#replaceLayerPixels((layer) =>
              this.#grownPixels(layer.pixels, size, layer === target ? paste : undefined),
            );
            this.#width = size.width;
            this.#height = size.height;
          }
          if (pasted) {
            const layer = this.#makeLayer(pasted, defaultLayerName(this.#layers.length));
            this.#insert(layer, this.#activeIndex() + 1);
            this.#active = layer;
          }
          this.#selection = selection;
        },
      );
    } catch (error) {
      pasted?.dispose();
      throw error;
    }
  }

  /**
   * DOC-CLP-05 with TL-MOVE-PIX-01: pastes `image` exactly as `pasteImage` does, which records its
   * history item, and then makes the pasted pixels the floating content of a Move Selected Pixels
   * session. The session keeps the layer under the paste, so the content can move before it is
   * finished. Returns the session.
   */
  pasteFloating(image: ClipboardImage, at: Point, options: PasteOptions = {}): FloatingPixels {
    this.history.assertIdle();
    const current: Size = { width: this.#width, height: this.#height };
    const size = options.expandTo ?? current;
    const area = pasteArea(image.pixels, at, rect(0, 0, size.width, size.height));
    const target = this.#requireActive();
    const prior = new Surface(area.width, area.height);
    const priorArea = intersectRects(area, rect(0, 0, current.width, current.height));
    if (!options.newLayer && !isEmptyRect(priorArea)) {
      const read = target.pixels.readRegion(priorArea);
      prior.copyFrom(read, read.bounds, priorArea.x - area.x, priorArea.y - area.y);
    }
    const content = pasteContent(image, this.#selection.quality);
    this.#paste(image, at, options, content);
    const layer = this.#requireActive();
    return new FloatingPixels({
      document: this,
      layer,
      pixels: content.pixels,
      coverage: content.coverage,
      origin: at,
      outline: imageOutline(image),
      area,
      base: prior,
      committed: layer.pixels.readRegion(area),
      selection: this.#selection,
    });
  }

  /**
   * TL-MOVE-PIX-01: lifts the selected pixels of the active layer into a floating session. The lifted
   * pixels leave the layer, so the vacated area becomes transparent once the session draws. With
   * nothing selected the whole canvas is selected and lifted, as Select All would (DOC-SEL-01): the
   * canvas rectangle moves with the content, and the session's first step records that selection
   * with the move, as one item. Records nothing until the session commits. Returns undefined when
   * there is no active layer or the area is empty.
   */
  liftSelectedPixels(): FloatingPixels | undefined {
    this.history.assertIdle();
    const layer = this.activeLayer;
    if (layer === undefined) return undefined;
    const selection = this.#selection;
    const canvas = rect(0, 0, this.#width, this.#height);
    const area = selection.isEmpty ? canvas : intersectRects(selection.bounds(), canvas);
    if (isEmptyRect(area)) return undefined;
    // The lift holds the content, the base and the committed state: three copies of the area.
    this.#preflight(3 * TiledPixelStore.estimateBytes(area.width, area.height), "move");
    // A selection that covers its whole bounds (Select All) needs no mask: every pixel moves whole.
    const coverage =
      selection.isEmpty || selection.coversRect(area) ? undefined : selection.mask(area);
    const committed = layer.pixels.readRegion(area);
    return new FloatingPixels({
      document: this,
      layer,
      // The content is the pixels as they are: the coverage, not their alpha, says how much of
      // each one the move carries, so it lands as it was lifted, transparency included.
      pixels: committed,
      coverage,
      origin: { x: area.x, y: area.y },
      outline: selection.isEmpty
        ? [rectPolygon(rect(0, 0, area.width, area.height))]
        : translatePolygons(selection.effectivePolygons(), -area.x, -area.y),
      area,
      base: remainingAfterLift(committed, coverage),
      committed,
      selection,
    });
  }

  /** DOC-CLP-01h: combines pasted outline polygons with the selection, as Paste Selection. */
  pasteSelection(polygons: readonly SelectionPolygon[], mode: SelectionCombineMode): void {
    this.#editSelection(t(PASTE_SELECTION_NAMES[mode]), this.#selection.combine(polygons, mode));
  }

  /**
   * DOC-SEL-06e: fills the selected pixels of the active layer with `color` and keeps the
   * selection. With nothing selected it fills the whole layer.
   */
  fillSelection(color: ColorRgba8): void {
    const layer = this.#requireActive();
    const area = this.#editArea();
    const selection = this.#selection;
    this.#editPixels(
      t("history.fillSelection"),
      layer,
      area,
      (pixels) => {
        overwriteSelection(pixels, area, selection, color);
      },
      selection,
    );
  }

  /**
   * DOC-IMG-01: crops every layer to the selection's bounding box, clipped to the canvas. Pixels
   * outside a non-rectangular selection become transparent. The selection moves with the content.
   * Does nothing and returns false when nothing is selected or the crop area is empty.
   */
  cropToSelection(): boolean {
    this.history.assertIdle();
    const selection = this.#selection;
    if (selection.isEmpty) return false;
    const area = intersectRects(selection.bounds(), rect(0, 0, this.#width, this.#height));
    if (isEmptyRect(area)) return false;
    this.#transact(t("history.cropToSelection"), this.#layers, () => {
      this.#replaceLayerPixels((layer) => this.#cropPixels(layer.pixels, area, selection));
      this.#width = area.width;
      this.#height = area.height;
      this.#selection = selection
        .transform({ ...IDENTITY_AFFINE, e: -area.x, f: -area.y })
        .commit();
    });
    return true;
  }

  /**
   * DOC-IMG-02: resamples every layer to `size` with `options`. `resolution` (default: the current
   * one) is set in the same item. With the same pixel size only the resolution changes. A resample
   * clears the selection. Returns false when nothing changed.
   */
  resize(size: Size, options: ResampleOptions, resolution?: Resolution): boolean {
    return this.#resizeDocument(
      t("history.resize"),
      size,
      resolution,
      (layer) => resampleLayerPixels(layer.pixels, size.width, size.height, options),
      new Selection([], this.#selection.quality),
      "resize",
    );
  }

  /**
   * DOC-IMG-02 as a background job. The result is the same as `resize`, but each layer is resampled
   * in its own slice, so the caller can show progress and cancel. The document is held while the
   * job runs, so no edit or undo can interleave. A cancel or failure before the swap leaves the
   * document unchanged. Returns false when nothing changed.
   */
  async resizeWithProgress(
    size: Size,
    options: ResampleOptions,
    resolution?: Resolution,
    control: JobControl = {},
  ): Promise<boolean> {
    this.history.assertIdle();
    const target = this.#resolveResize(size, resolution);
    if (this.#isCurrentSize(size)) return this.#setResolutionOnly(target);
    const layers = [...this.#layers];
    this.#preflight(layersBytes(size.width, size.height, layers.length), "resize");
    const built = new Map<Layer, TiledPixelStore>();
    const release = this.history.hold();
    try {
      for (const [index, layer] of layers.entries()) {
        await control.pause?.();
        throwIfCanceled(control);
        built.set(
          layer,
          control.resample === undefined
            ? resampleLayerPixels(layer.pixels, size.width, size.height, options)
            : await resampleLayerPixelsWith(
                layer.pixels,
                size.width,
                size.height,
                options,
                control.resample,
                control.pause,
              ),
        );
        control.onProgress?.((index + 1) / layers.length);
      }
      throwIfCanceled(control);
    } catch (error) {
      for (const pixels of built.values()) pixels.dispose();
      throw error;
    } finally {
      release();
    }
    this.#transact(t("history.resize"), layers, () => {
      this.#swapLayerPixels(built);
      this.#width = size.width;
      this.#height = size.height;
      this.#resolution = target;
      this.#selection = new Selection([], this.#selection.quality);
    });
    return true;
  }

  /**
   * DOC-IMG-03: sets the canvas size of every layer. The pixels are placed by `anchor`, and each
   * layer's new area is `fill`. The selection moves with the pixels. With the same pixel size only
   * the resolution changes. Returns false when nothing changed.
   */
  resizeCanvas(
    size: Size,
    anchor: CanvasAnchor,
    fill: ColorRgba8,
    resolution?: Resolution,
  ): boolean {
    const { x, y } = canvasOffset(anchor, { width: this.#width, height: this.#height }, size);
    return this.#resizeDocument(
      t("history.canvasSize"),
      size,
      resolution,
      (layer) => placeLayerPixels(layer.pixels, size.width, size.height, x, y, fill),
      this.#selection.transform({ ...IDENTITY_AFFINE, e: x, f: y }).commit(),
      "canvasSize",
    );
  }

  /** DOC-IMG-04/05: mirrors every layer across `axis`. The selection is mirrored too. */
  flipImage(axis: ImageAxis): void {
    this.history.assertIdle();
    const flipX = axis === "horizontal";
    const selection = this.#selection
      .transform(flipMatrix(axis, { width: this.#width, height: this.#height }))
      .commit();
    this.#transact(t(FLIP_NAMES[axis]), [...this.#layers], () => {
      this.#replaceLayerPixels((layer) => mirrorLayerPixels(layer.pixels, flipX, !flipX));
      this.#selection = selection;
    });
  }

  /**
   * DOC-IMG-06/07/08: rotates every layer losslessly. A 90° turn swaps the width and height. The
   * selection rotates with the image.
   */
  rotateImage(rotation: ImageRotation): void {
    this.history.assertIdle();
    const size = { width: this.#width, height: this.#height };
    const next = rotatedSize(size, rotation);
    const selection = this.#selection.transform(rotationMatrix(rotation, size)).commit();
    this.#transact(t(ROTATION_NAMES[rotation]), [...this.#layers], () => {
      this.#replaceLayerPixels((layer) => rotateLayerPixels(layer.pixels, rotation));
      this.#width = next.width;
      this.#height = next.height;
      this.#selection = selection;
    });
  }

  /**
   * DOC-IMG-09: replaces every layer with one "Background" layer that holds the visible layers
   * composited over transparency. Hidden layers are discarded, the selection is cleared, and the
   * new layer keeps the metadata of the bottom layer. Returns false with fewer than two layers.
   */
  flatten(): boolean {
    this.history.assertIdle();
    const [bottom] = this.#layers;
    if (this.#layers.length < 2 || !bottom) return false;
    this.#transact(t("history.flatten"), [...this.#layers], () => {
      const pixels = flattenLayerPixels(
        this.#layers.filter((layer) => layer.visible),
        this.#width,
        this.#height,
        { accountant: this.accountant, colorProfile: this.colorProfile },
      );
      const merged = this.#makeLayer(pixels, BACKGROUND_LAYER_NAME, true);
      for (const [name, value] of bottom.metadata.entries()) merged.metadata.set(name, value);
      for (const layer of this.#layers) layer.dispose();
      this.#layers = [merged];
      this.#active = merged;
      this.#selection = new Selection([], this.#selection.quality);
    });
    return true;
  }

  /** DOC-SEL-02: combines a new polygon set with the selection using `mode`. */
  combineSelection(
    polygons: readonly SelectionPolygon[],
    mode: SelectionCombineMode,
    historyName: string = t("history.editSelection"),
  ): void {
    this.#editSelection(historyName, this.#selection.combine(polygons, mode));
  }

  /**
   * Sets the selection to `selection` as one history item named `historyName`. Tools that edit a
   * pending selection step by step use this, since the new value is not a combine (TL-SEL-WAND-01).
   */
  replaceSelection(selection: Selection, historyName: string): void {
    this.#editSelection(historyName, selection);
  }

  /**
   * DOC-SEL-02 live preview: sets the selection without a history item, so a selection tool can show
   * the shape it is drawing (TL-SEL-01). The dirty flag does not change. Listeners are notified with
   * `"selection"`. The caller restores the earlier selection with `restoreSelection` (Cancel), or
   * commits the result with `combineSelection`.
   */
  previewSelection(selection: Selection): void {
    this.history.assertIdle();
    this.#selection = selection;
    this.#notify("selection");
  }

  /**
   * Puts back the selection that a live preview replaced, when the preview is canceled or has
   * failed. Like `restoreLayerPixels`, it works while the history is busy or held.
   */
  restoreSelection(selection: Selection): void {
    this.#selection = selection;
    this.#notify("selection");
  }

  /** DOC-SEL-03: changes the edge quality. Returns false when it is already set. */
  setSelectionQuality(quality: SelectionQuality): boolean {
    if (this.#selection.quality === quality) return false;
    this.#editSelection(t("history.changeSelectionQuality"), this.#selection.withQuality(quality));
    return true;
  }

  /** DOC-DOC-06: true while the document differs from its last saved state. */
  get dirty(): boolean {
    return !this.history.isSaved;
  }

  /** Marks the current state as saved, e.g. after a successful save (DOC-DOC-06). */
  markClean(): void {
    this.history.markSaved();
  }

  /** Marks the document dirty, e.g. when a file opened with changes it must save (FMT-NAT-07). */
  markUnsaved(): void {
    this.history.markUnsaved();
  }

  /**
   * Captures the document and its history for session recovery (WEB-MEM-05): the layers and their
   * pixels, the selection, the metadata, and every history item with the saved position. Throws
   * while an undo or redo runs, so the caller tries again later.
   *
   * The state is captured synchronously when the call is made. Only the spilled history data is read
   * afterwards, and its handles are pinned for the read, so a checkpoint never blocks edits, live
   * previews, undo or redo while it finishes.
   *
   * Blob names follow their content (`layerRowBlobName`, `historyBlobName`). Blobs named in `known`,
   * which the caller already stored, are neither captured nor read again and are listed in
   * `reused`, so a checkpoint after an edit costs only what the edit changed (L2).
   */
  async checkpoint(
    known: ReadonlySet<string> = new Set(),
    pause?: () => Promise<void>,
  ): Promise<DocumentCheckpoint> {
    // With a pause, the layers' pixels are copied a tile row at a time first, between pauses (L5,
    // L10). Rows that change meanwhile get a new name and are copied again in the final pass.
    const early = new Map<string, Uint8Array>();
    if (pause !== undefined) {
      let sliceStart = performance.now();
      for (const layer of [...this.#layers]) {
        for (const { ty, name } of pixelRows(layer)) {
          if (known.has(name) || early.has(name)) continue;
          early.set(name, captureRow(layer.pixels, ty));
          if (performance.now() - sliceStart >= CHECKPOINT_SLICE_MS) {
            await pause();
            sliceStart = performance.now();
          }
        }
      }
    }
    if (this.history.busy) throw new Error(BUSY_MESSAGE);
    const blobs = new Map<string, Uint8Array>();
    const reused = new Set<string>();
    const spilled = new Map<number, { readonly name: string; readonly handle: SpillHandle }>();
    const historyBlob = (handle: SpillHandle): string => {
      const name = historyBlobName(handle.id);
      if (known.has(name)) reused.add(name);
      else spilled.set(handle.id, { name, handle });
      return name;
    };
    const snapshotOf = (snapshot: DocumentSnapshot): CheckpointSnapshot => ({
      width: snapshot.width,
      height: snapshot.height,
      resolution: snapshot.resolution,
      activeLayerId: snapshot.activeLayer?.id ?? null,
      selection: selectionJson(snapshot.selection),
      layers: snapshot.layers.map(
        (entry): CheckpointLayer => ({
          ...layerInfo(entry.layer),
          properties: entry.properties,
          metadata: entry.metadata.map(([name, value]) => [name, value] as const),
          ...(entry.pixels === undefined ? {} : { pixels: historyBlob(entry.pixels) }),
        }),
      ),
    });

    const itemOf = (command: HistoryCommand): CheckpointItem => {
      if (command.parts !== undefined) {
        return { kind: "compound", name: command.name, items: command.parts.map(itemOf) };
      }
      const data = this.#items.get(command);
      if (data === undefined) return { kind: "base", name: command.name };
      if (data.kind === "snapshot") {
        return {
          kind: "snapshot",
          name: command.name,
          before: snapshotOf(data.before),
          after: snapshotOf(data.after),
        };
      }
      return {
        kind: "pixels",
        name: command.name,
        layer: layerInfo(data.layer),
        beforePatch: historyBlob(data.beforePatch),
        afterPatch: historyBlob(data.afterPatch),
        selectionBefore: selectionJson(data.selectionBefore),
        selectionAfter: selectionJson(data.selectionAfter),
      };
    };

    const items = [...this.history.appliedCommands, ...this.history.undoneCommands].map(itemOf);

    const layers: CheckpointLayer[] = [];
    for (const layer of this.#layers) {
      const pixels: string[] = [];
      for (const { ty, name } of pixelRows(layer)) {
        pixels.push(name);
        if (known.has(name)) reused.add(name);
        else blobs.set(name, early.get(name) ?? captureRow(layer.pixels, ty));
      }
      layers.push({ ...layerInfo(layer), metadata: metadataEntries(layer.metadata), pixels });
    }

    const manifest: DocumentCheckpointManifest = {
      format: CHECKPOINT_FORMAT,
      version: CHECKPOINT_VERSION,
      width: this.#width,
      height: this.#height,
      resolution: this.#resolution,
      colorProfile: this.colorProfile,
      metadata: metadataJson(this.metadata),
      formatExtras: encodeJson(this.formatExtras),
      nextLayerId: this.#nextLayerId,
      activeLayerId: this.#active?.id ?? null,
      selection: selectionJson(this.#selection),
      layers,
      history: {
        items,
        appliedCount: this.history.appliedCommands.length,
        saved: this.history.savedLocation,
      },
    };

    const unpin = this.#spill.pin([...spilled.values()].map((entry) => entry.handle));
    try {
      for (const { name, handle } of spilled.values()) {
        blobs.set(name, await this.#spill.get(handle));
      }
    } finally {
      unpin();
    }
    return { manifest, blobs, reused: [...reused] };
  }

  /**
   * Rebuilds a document from its checkpoint (WEB-MEM-05, SET-LIFE-11). The layers, selection,
   * metadata and history come back with the saved position, so the document is clean or dirty as
   * it was. Throws a CheckpointError for a checkpoint this version did not write.
   */
  static async fromCheckpoint(
    checkpoint: DocumentCheckpoint,
    options: Pick<DocumentOptions, "accountant" | "spill"> = {},
  ): Promise<Document> {
    const manifest = checkpoint.manifest;
    if (manifest.format !== CHECKPOINT_FORMAT || manifest.version !== CHECKPOINT_VERSION) {
      throw new CheckpointError("The checkpoint is not from this version of OpenPaint.");
    }
    const doc = new Document({
      ...options,
      width: manifest.width,
      height: manifest.height,
      resolution: manifest.resolution,
      colorProfile: manifest.colorProfile,
      formatExtras: decodeJson(manifest.formatExtras) as FormatExtras,
    });
    const blob = (name: string): Uint8Array => {
      const data = checkpoint.blobs.get(name);
      if (data === undefined) throw new CheckpointError(`The checkpoint is missing ${name}.`);
      return data;
    };
    try {
      doc.#preflight(
        manifest.layers.length * TiledPixelStore.estimateBytes(manifest.width, manifest.height),
        "newImage",
      );
      const byId = new Map<number, Layer>();
      const layers: Layer[] = [];
      for (const entry of manifest.layers) {
        if (entry.pixels === undefined) {
          throw new CheckpointError(`Layer ${entry.id} has no pixels in the checkpoint.`);
        }
        const pixels = doc.#newPixels();
        for (const name of typeof entry.pixels === "string" ? [entry.pixels] : entry.pixels) {
          restoreTiles(pixels, blob(name));
        }
        const layer = layerFromInfo(entry, pixels);
        for (const [name, value] of entry.metadata)
          layer.metadata.set(name, decodeJson(value) as string);
        byId.set(layer.id, layer);
        layers.push(layer);
      }
      doc.#layers = layers;
      doc.#active = manifest.activeLayerId === null ? undefined : byId.get(manifest.activeLayerId);
      doc.#nextLayerId = manifest.nextLayerId;
      doc.#selection = selectionFromJson(manifest.selection);
      applyMetadataJson(doc.metadata, manifest.metadata);

      // A layer that a history item names but the document no longer has starts empty. Every
      // item that brings it back restores its pixels, so the empty store is never read.
      const layerFor = (info: LayerInfo): Layer => {
        const known = byId.get(info.id);
        if (known !== undefined) return known;
        const placeholder = layerFromInfo(info, doc.#newPixels());
        byId.set(info.id, placeholder);
        return placeholder;
      };
      const commands = manifest.history.items.map((item) =>
        doc.#commandFromJson(item, layerFor, blob),
      );
      const split = manifest.history.appliedCount;
      doc.history.restore(commands.slice(0, split), commands.slice(split), manifest.history.saved);
      return doc;
    } catch (error) {
      doc.dispose();
      throw error;
    }
  }

  #commandFromJson(
    item: CheckpointItem,
    layerFor: (info: LayerInfo) => Layer,
    blob: (name: string) => Uint8Array,
  ): HistoryCommand {
    if (item.kind === "base") return placeholderCommand(item.name);
    if (item.kind === "compound") {
      return compoundCommand(
        item.name,
        item.items.map((part) => this.#commandFromJson(part, layerFor, blob)),
      );
    }
    if (item.kind === "snapshot") {
      return this.#command(item.name, {
        kind: "snapshot",
        before: this.#snapshotFromJson(item.before, layerFor, blob),
        after: this.#snapshotFromJson(item.after, layerFor, blob),
      });
    }
    return this.#command(item.name, {
      kind: "pixels",
      layer: layerFor(item.layer),
      beforePatch: this.#spill.put(blob(item.beforePatch)),
      afterPatch: this.#spill.put(blob(item.afterPatch)),
      selectionBefore: selectionFromJson(item.selectionBefore),
      selectionAfter: selectionFromJson(item.selectionAfter),
    });
  }

  #snapshotFromJson(
    json: CheckpointSnapshot,
    layerFor: (info: LayerInfo) => Layer,
    blob: (name: string) => Uint8Array,
  ): DocumentSnapshot {
    const active = json.layers.find((entry) => entry.id === json.activeLayerId);
    return {
      width: json.width,
      height: json.height,
      layers: json.layers.map((entry) => ({
        layer: layerFor(entry),
        properties: entry.properties,
        metadata: entry.metadata.map(([name, value]) => [name, value as string] as const),
        pixels:
          entry.pixels === undefined ? undefined : this.#spill.put(blob(singleBlob(entry.pixels))),
      })),
      activeLayer: active === undefined ? undefined : layerFor(active),
      selection: selectionFromJson(json.selection),
      resolution: json.resolution,
    };
  }

  /**
   * DOC-HIS-01 step group: runs `action` so that every change it makes is one compound history item
   * named `name`. One undo steps back over all of them. Returns what `action` returns.
   */
  group<T>(name: string, action: () => T): T {
    return this.history.group(name, action);
  }

  /**
   * Calls `listener` after every change, including undo and redo, with the kind of change. Listeners
   * that only show the document's structure (layer list, history, title, menus) should ignore
   * `"preview"` changes, which come once per frame while a tool or effect previews pixels. Returns
   * the unsubscribe function.
   */
  subscribe(listener: (change: DocumentChange) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** DOC-LYR-05a: adds a transparent layer directly above the active layer and activates it. */
  addLayer(): Layer {
    return this.#transact(t("history.newLayer"), [], () => {
      const layer = this.#makeLayer(this.#newPixels(), defaultLayerName(this.#layers.length));
      this.#insert(layer, this.#activeIndex() + 1);
      this.#active = layer;
      return layer;
    });
  }

  /**
   * DOC-LYR-05e: adds `pixels` as a new layer named `name`, above the active layer, with its
   * top-left at the canvas origin. `expandTo` grows the canvas first, anchored top-left with
   * transparent fill. The growth and the new layer form one "Import From File" item.
   */
  importLayer(name: string, pixels: Surface, options: { readonly expandTo?: Size } = {}): Layer {
    this.history.assertIdle();
    const current: Size = { width: this.#width, height: this.#height };
    const size = options.expandTo ?? current;
    if (size.width < current.width || size.height < current.height) {
      throw new RangeError("An import can only expand the canvas.");
    }
    if (!isValidImageSize(size.width, size.height)) {
      throw new RangeError(`Invalid image size ${size.width}x${size.height}.`);
    }
    const grows = size.width !== current.width || size.height !== current.height;
    this.#preflight(
      grows
        ? layersBytes(size.width, size.height, this.#layers.length + 1)
        : TiledPixelStore.estimateBytes(size.width, size.height),
      "import",
    );
    const imported = this.#newPixels(size.width, size.height);
    try {
      imported.writeRegion(pixels, 0, 0);
      return this.#transact(t("history.importFromFile"), grows ? [...this.#layers] : [], () => {
        if (grows) {
          this.#replaceLayerPixels((layer) => this.#grownPixels(layer.pixels, size, undefined));
          this.#width = size.width;
          this.#height = size.height;
        }
        const layer = this.#makeLayer(imported, name);
        this.#insert(layer, this.#activeIndex() + 1);
        this.#active = layer;
        return layer;
      });
    } catch (error) {
      imported.dispose();
      throw error;
    }
  }

  /** DOC-LYR-05b: removes the active layer. Refused when it is the only layer. */
  deleteActiveLayer(): void {
    const layer = this.#requireActive();
    if (this.#layers.length <= 1) {
      throw new LayerError("last-layer", "There must be at least one layer in an image.");
    }
    this.#transact(t("history.deleteLayer"), [layer], () => {
      const index = this.#layers.indexOf(layer);
      this.#layers.splice(index, 1);
      this.#active = this.#layers[Math.max(0, index - 1)];
      layer.dispose();
    });
  }

  /** DOC-LYR-05c: clones the active layer's pixels and properties above it and activates the copy. */
  duplicateActiveLayer(): Layer {
    const source = this.#requireActive();
    return this.#transact(t("history.duplicateLayer"), [], () => {
      const copy = this.#makeLayer(cloneLayerPixels(source.pixels), source.name, false, {
        ...source.properties,
        rawBlendMode: source.rawBlendMode,
        extras: source.extras,
      });
      for (const [name, value] of source.metadata.entries()) copy.metadata.set(name, value);
      this.#insert(copy, this.#layers.indexOf(source) + 1);
      this.#active = copy;
      return copy;
    });
  }

  /**
   * DOC-LYR-05d: composites the active layer onto the layer below with the active layer's blend
   * mode and opacity, then removes the active layer. The lower layer keeps its own properties.
   * The hidden flag is ignored, so a hidden layer still merges.
   */
  mergeActiveLayerDown(): void {
    const upper = this.#requireActive();
    const index = this.#layers.indexOf(upper);
    const lower = this.#layers[index - 1];
    if (index < 1 || !lower) {
      throw new LayerError("no-layer-below", "There is no layer below to merge into.");
    }
    this.#transact(t("history.mergeLayerDown"), [lower, upper], () => {
      const merged = compositeLayerPixels(
        lower.pixels,
        upper.pixels,
        upper.blendMode,
        upper.opacity,
      );
      lower.replacePixels(merged).dispose();
      this.#layers.splice(this.#layers.indexOf(upper), 1);
      upper.dispose();
      this.#active = lower;
    });
  }

  /** DOC-LYR-05j: swaps the active layer with the one above. Returns false at the top. */
  moveActiveLayerUp(): boolean {
    return this.#moveActiveTo(
      Math.min(this.#activeIndex() + 1, this.#layers.length - 1),
      t("history.moveLayerUp"),
    );
  }

  /** DOC-LYR-05k: swaps the active layer with the one below. Returns false at the bottom. */
  moveActiveLayerDown(): boolean {
    return this.#moveActiveTo(Math.max(this.#activeIndex() - 1, 0), t("history.moveLayerDown"));
  }

  /** DOC-LYR-05l. Returns false when the layer is already on top. */
  moveActiveLayerToTop(): boolean {
    return this.#moveActiveTo(this.#layers.length - 1, t("history.moveLayerToTop"));
  }

  /** DOC-LYR-05m. Returns false when the layer is already at the bottom. */
  moveActiveLayerToBottom(): boolean {
    return this.#moveActiveTo(0, t("history.moveLayerToBottom"));
  }

  /**
   * Moves the active layer to position `index` (0 is the bottom), as the Layers panel does when a
   * layer is dragged. History name "Move Layer". Returns false when it is already there.
   */
  moveActiveLayerTo(index: number): boolean {
    this.#checkLayerIndex(index);
    return this.#moveActiveTo(index, t("history.moveLayer"));
  }

  /**
   * Exchanges the active layer with the layer at position `index`, as the Layers panel does when a
   * layer is dropped on another. History name "Swap Layer". Returns false for the active layer's
   * own position.
   */
  swapActiveLayerWith(index: number): boolean {
    this.#checkLayerIndex(index);
    this.history.assertIdle();
    const layer = this.#requireActive();
    const from = this.#layers.indexOf(layer);
    if (from === index) return false;
    this.#transact(t("history.swapLayer"), [], () => {
      const other = this.#layers[index];
      if (!other) throw new RangeError(`No layer at index ${index}.`);
      this.#layers[index] = layer;
      this.#layers[from] = other;
    });
    return true;
  }

  /** DOC-LYR-05f: mirrors the active layer left to right. */
  flipActiveLayerHorizontal(): void {
    this.#transformActive(t("history.flipHorizontal"), true, false);
  }

  /** DOC-LYR-05g: mirrors the active layer top to bottom. */
  flipActiveLayerVertical(): void {
    this.#transformActive(t("history.flipVertical"), false, true);
  }

  /** DOC-LYR-05h: rotates the active layer 180°, which is lossless. */
  rotateActiveLayer180(): void {
    this.#transformActive(t("history.rotate180"), true, true);
  }

  /**
   * Applies validated property changes to the active layer (DOC-LYR-02). Only a real change is
   * recorded, named after the changed property ("Layer Opacity"; "Layer Properties" for several).
   * Returns whether it changed.
   */
  setActiveLayerProperties(patch: Partial<LayerProperties>): boolean {
    this.history.assertIdle();
    const layer = this.#requireActive();
    const before = this.#snapshot([]);
    const previous = layer.properties;
    if (!layer.applyProperties(patch)) return false;
    this.#record(propertyHistoryName(previous, layer.properties), before, this.#snapshot([]));
    return true;
  }

  /**
   * DOC-LYR-02 live preview: applies properties to the active layer without a history item, so the
   * canvas shows them while the Layer Properties dialog is open. The dirty flag does not change.
   * Listeners are notified. Commit with `setActiveLayerProperties`, or restore the earlier values
   * with this method (Cancel).
   */
  previewActiveLayerProperties(patch: Partial<LayerProperties>): void {
    this.history.assertIdle();
    this.#requireActive().applyProperties(patch);
    this.#notify();
  }

  /**
   * Edits the pixels of `area` on one layer through `edit` and records the change as a tile-level
   * item (ARC-04-06, DOC-HIS-02). Only the tiles covering `area` (a rectangle, or several, such as a
   * shape's outline) are captured before and after. `edit` must not change pixels outside `area`.
   */
  editLayerPixels(
    name: string,
    layer: Layer,
    area: Rect | readonly Rect[],
    edit: (pixels: TiledPixelStore) => void,
    selectionAfter: Selection = this.#selection,
  ): void {
    this.#editPixels(name, layer, area, edit, selectionAfter);
  }

  /**
   * Records pixels that are already on the layer as one tile-level history item (DOC-HIS-02), such
   * as an effect's live preview that is committed. `before` holds `area`'s pixels before the change,
   * or the whole earlier tiles under it, and nothing outside `area` may have changed. Unlike `editLayerPixels`, the layer is not written
   * again: the item is made from `before` and the current tiles, so a commit copies each byte twice
   * rather than five times (L9).
   */
  recordLayerPixels(
    name: string,
    layer: Layer,
    area: Rect,
    before: Surface | EarlierTiles,
    selectionAfter: Selection = this.#selection,
  ): void {
    this.history.assertIdle();
    if (!this.#layers.includes(layer)) throw new RangeError("The layer is not in this document.");
    const beforePatch = this.#spill.put(captureTilesBefore(layer.pixels, area, before));
    const afterPatch = this.#spill.put(captureTiles(layer.pixels, area));
    const selectionBefore = this.#selection;
    this.#selection = selectionAfter;
    this.#recordItem(name, {
      kind: "pixels",
      layer,
      beforePatch,
      afterPatch,
      selectionBefore,
      selectionAfter,
    });
  }

  /**
   * Shared by `editLayerPixels`. It also sets the selection to `selectionAfter` as part of the same
   * history item. Undo and redo restore the matching selection with the pixels.
   */
  #editPixels(
    name: string,
    layer: Layer,
    area: Rect | readonly Rect[],
    edit: (pixels: TiledPixelStore) => void,
    selectionAfter: Selection,
  ): void {
    this.history.assertIdle();
    if (!this.#layers.includes(layer)) throw new RangeError("The layer is not in this document.");
    const selectionBefore = this.#selection;
    const before = this.#spill.put(captureTiles(layer.pixels, area));
    try {
      edit(layer.pixels);
    } catch (error) {
      this.#spill.release(before);
      throw error;
    }
    const after = this.#spill.put(captureTiles(layer.pixels, area));
    this.#selection = selectionAfter;
    this.#recordItem(name, {
      kind: "pixels",
      layer,
      beforePatch: before,
      afterPatch: after,
      selectionBefore,
      selectionAfter,
    });
  }

  /**
   * Writes the pixels of one layer for a live preview, such as a stroke in progress (the same
   * pattern as an effect preview). No history item is recorded and the dirty flag does not change.
   * Listeners are notified. The caller restores the original pixels and commits the result with
   * `editLayerPixels`, so the history item holds the real before and after.
   */
  previewLayerPixels(layer: Layer, write: (pixels: TiledPixelStore) => void): void {
    this.history.assertIdle();
    if (!this.#layers.includes(layer)) throw new RangeError("The layer is not in this document.");
    write(layer.pixels);
    this.#notify("preview");
  }

  /**
   * Writes back the pixels that a live preview replaced, when the preview is canceled or has failed.
   * Unlike `previewLayerPixels`, it works while an undo, a redo or a background job runs: putting the
   * layer back is always right, and it must not fail, or part of the preview would stay on the layer.
   * Listeners are notified when the layer is in this document.
   */
  restoreLayerPixels(layer: Layer, write: (pixels: TiledPixelStore) => void): void {
    write(layer.pixels);
    if (this.#layers.includes(layer)) this.#notify("preview");
  }

  /**
   * Tells listeners that a live preview changed `layer`'s pixels by writing its store directly, such
   * as an effect preview written tile by tile (FX-FW-PREVIEW-01). Nothing else changes.
   */
  layerPreviewChanged(layer: Layer): void {
    if (this.#layers.includes(layer)) this.#notify("preview");
  }

  /**
   * Shows `preview` over `layer` on the canvas, or stops showing one (undefined), without touching
   * its pixels (FX-FW-PREVIEW-01). Nothing is recorded. Like `restoreLayerPixels`, it works while
   * the history is busy, so a preview can always be taken down. Listeners are notified.
   */
  setLayerLivePreview(layer: Layer, preview: LayerLivePreview | undefined): void {
    if (layer.livePreview === preview) return;
    layer.setLivePreview(preview);
    if (this.#layers.includes(layer)) this.#notify("preview");
  }

  /**
   * Shows floating content over `layer` on the canvas, or stops showing it (undefined), without
   * touching its pixels (TL-MOVE-PIX-01). Nothing is recorded. Like `setLayerLivePreview`, it works
   * while the history is busy. Listeners are notified.
   */
  setLayerFloatPreview(layer: Layer, preview: LayerFloatPreview | undefined): void {
    if (layer.floatPreview === preview) return;
    layer.setFloatPreview(preview);
    if (this.#layers.includes(layer)) this.#notify("preview");
  }

  /** Frees every layer's pixels and the undo data. The document must not be used afterwards. */
  dispose(): void {
    this.history.clear();
    for (const layer of this.#layers) layer.dispose();
    this.#layers = [];
    this.#active = undefined;
  }

  #newPixels(width = this.#width, height = this.#height): TiledPixelStore {
    return new TiledPixelStore(width, height, {
      accountant: this.accountant,
      colorProfile: this.colorProfile,
    });
  }

  #makeLayer(
    pixels: TiledPixelStore,
    name: string,
    isBackground = false,
    properties: Partial<LayerInit> = {},
  ): Layer {
    return new Layer(this.#nextLayerId++, pixels, {
      name,
      visible: true,
      opacity: DEFAULT_LAYER_OPACITY,
      blendMode: LayerBlendMode.normal,
      isBackground,
      ...properties,
    });
  }

  #insert(layer: Layer, index: number): void {
    this.#layers.splice(index, 0, layer);
  }

  #requireActive(): Layer {
    if (!this.#active) throw new LayerError("no-active-layer", "The image has no layers.");
    return this.#active;
  }

  #activeIndex(): number {
    return this.#active ? this.#layers.indexOf(this.#active) : -1;
  }

  #checkLayerIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.#layers.length) {
      throw new RangeError(`Layer index ${index} is out of range.`);
    }
  }

  #moveActiveTo(target: number, name: string): boolean {
    const layer = this.#requireActive();
    const from = this.#layers.indexOf(layer);
    if (from === target) return false;
    this.#transact(name, [], () => {
      this.#layers.splice(from, 1);
      this.#layers.splice(target, 0, layer);
    });
    return true;
  }

  #transformActive(name: string, flipX: boolean, flipY: boolean): void {
    const layer = this.#requireActive();
    this.#transact(name, [layer], () => {
      layer.replacePixels(mirrorLayerPixels(layer.pixels, flipX, flipY)).dispose();
    });
  }

  /** Clears the selected pixels of the active layer and deselects, as one item named `name`. */
  #erase(name: string): void {
    const layer = this.#requireActive();
    const area = this.#editArea();
    const selection = this.#selection;
    this.#editPixels(
      name,
      layer,
      area,
      (pixels) => {
        overwriteSelection(pixels, area, selection, TRANSPARENT);
      },
      new Selection([], selection.quality),
    );
  }

  /** A new store of `size` holding only the pasted image. */
  #pastedPixels(size: Size, content: FloatingContent, at: Point): TiledPixelStore {
    const pixels = this.#newPixels(size.width, size.height);
    try {
      pasteReplace(pixels, content, at);
    } catch (error) {
      pixels.dispose();
      throw error;
    }
    return pixels;
  }

  /** `source` placed at the top-left of a `size` canvas, with `paste` placed on it if given. */
  #grownPixels(
    source: TiledPixelStore,
    size: Size,
    paste: { readonly content: FloatingContent; readonly at: Point } | undefined,
  ): TiledPixelStore {
    const grown = placeLayerPixels(source, size.width, size.height, 0, 0, TRANSPARENT);
    if (!paste) return grown;
    try {
      pasteReplace(grown, paste.content, paste.at);
    } catch (error) {
      grown.dispose();
      throw error;
    }
    return grown;
  }

  /** The area that pixel edits cover: the selection's bounds on the canvas, or the whole canvas. */
  #editArea(): Rect {
    const canvas = rect(0, 0, this.#width, this.#height);
    return this.#selection.isEmpty ? canvas : intersectRects(this.#selection.bounds(), canvas);
  }

  /**
   * Builds each layer's new pixels, then swaps them in together. If a build fails, nothing changes
   * and the stores built so far are freed.
   */
  #replaceLayerPixels(build: (layer: Layer) => TiledPixelStore): void {
    const built = new Map<Layer, TiledPixelStore>();
    try {
      for (const layer of this.#layers) built.set(layer, build(layer));
    } catch (error) {
      for (const pixels of built.values()) pixels.dispose();
      throw error;
    }
    this.#swapLayerPixels(built);
  }

  #swapLayerPixels(built: ReadonlyMap<Layer, TiledPixelStore>): void {
    for (const [layer, pixels] of built) layer.resizePixels(pixels).dispose();
  }

  /** Validates a target size and resolution (DOC-DOC-01, DOC-DOC-03). The resolution defaults to the current one. */
  #resolveResize(size: Size, resolution: Resolution | undefined): Resolution {
    if (!isValidImageSize(size.width, size.height)) {
      throw new RangeError(`Invalid image size ${size.width}x${size.height}.`);
    }
    const target = resolution ?? this.#resolution;
    if (!isValidResolution(target)) throw new RangeError("Invalid resolution.");
    return target;
  }

  #isCurrentSize(size: Size): boolean {
    return size.width === this.#width && size.height === this.#height;
  }

  /** A same-size resize only changes the resolution. Returns false when it is already set. */
  #setResolutionOnly(target: Resolution): boolean {
    if (sameResolution(target, this.#resolution)) return false;
    this.setResolution(target);
    return true;
  }

  /**
   * The shared path of Resize and Canvas Size. An unchanged pixel size only changes the resolution,
   * as a "Resize" item. Otherwise every layer gets new pixels and the size, resolution and
   * selection change in one item.
   */
  #resizeDocument(
    name: string,
    size: Size,
    resolution: Resolution | undefined,
    pixelsOf: (layer: Layer) => TiledPixelStore,
    selection: Selection,
    operation: MemoryOperation,
  ): boolean {
    this.history.assertIdle();
    const target = this.#resolveResize(size, resolution);
    if (this.#isCurrentSize(size)) return this.#setResolutionOnly(target);
    this.#preflight(layersBytes(size.width, size.height, this.#layers.length), operation);
    this.#transact(name, [...this.#layers], () => {
      this.#replaceLayerPixels(pixelsOf);
      this.#width = size.width;
      this.#height = size.height;
      this.#resolution = target;
      this.#selection = selection;
    });
    return true;
  }

  /** The part of `source` inside `area`, with alpha clipped to the selection (DOC-IMG-01). */
  #cropPixels(source: TiledPixelStore, area: Rect, selection: Selection): TiledPixelStore {
    const out = this.#newPixels(area.width, area.height);
    try {
      const region = source.readRegion(area);
      clipAlphaToCoverage(region, selection.mask(area));
      out.writeRegion(region, 0, 0);
    } catch (error) {
      out.dispose();
      throw error;
    }
    return out;
  }

  /**
   * WEB-MEM-03: refuses an operation whose estimated bytes do not fit the budget that is left. The
   * check runs before any work, so the error names the operation and nothing has changed.
   */
  #preflight(bytes: number, operation: MemoryOperation): void {
    if (!this.accountant.canReserve(bytes)) {
      throw new OutOfMemoryError(bytes, this.accountant.availableBytes, operation);
    }
  }

  /** The worst-case bytes a paste allocates, given what it grows or adds. */
  #pasteBytes(image: ClipboardImage, size: Size, grows: boolean, newLayer: boolean): number {
    if (grows)
      return layersBytes(size.width, size.height, this.#layers.length + (newLayer ? 1 : 0));
    if (newLayer) return TiledPixelStore.estimateBytes(size.width, size.height);
    return TiledPixelStore.estimateBytes(image.pixels.width, image.pixels.height);
  }

  #editSelection(name: string, selection: Selection): void {
    this.#editState(name, () => {
      this.#selection = selection;
    });
  }

  /** Records a change that touches no pixels: only layer order, properties, selection or resolution. */
  #editState(name: string, mutate: () => void): void {
    this.history.assertIdle();
    const before = this.#snapshot([]);
    mutate();
    this.#record(name, before, this.#snapshot([]));
  }

  /**
   * Runs a structural or pixel change as one history item (DOC-HIS-03). `touched` lists the
   * layers whose pixels the change replaces or removes; they are spilled before the change. Layers
   * that exist only after it (new ones) are spilled after it. If `mutate` throws, nothing is
   * recorded and the spilled copies are released.
   */
  #transact<T>(name: string, touched: readonly Layer[], mutate: () => T): T {
    this.history.assertIdle();
    const before = this.#snapshot(touched);
    let result: T;
    try {
      result = mutate();
    } catch (error) {
      this.#releaseSnapshot(before);
      throw error;
    }
    const isNew = (layer: Layer) => !before.layers.some((entry) => entry.layer === layer);
    const spilledAfter = this.#layers.filter((layer) => touched.includes(layer) || isNew(layer));
    this.#record(name, before, this.#snapshot(spilledAfter));
    return result;
  }

  /** Captures the document state. Only layers in `spilled` get their pixels spilled. */
  #snapshot(spilled: readonly Layer[]): DocumentSnapshot {
    return {
      width: this.#width,
      height: this.#height,
      layers: this.#layers.map((layer) => ({
        layer,
        properties: layer.properties,
        metadata: [...layer.metadata.entries()],
        pixels: spilled.includes(layer) ? this.#spill.put(captureTiles(layer.pixels)) : undefined,
      })),
      activeLayer: this.#active,
      selection: this.#selection,
      resolution: this.#resolution,
    };
  }

  #record(name: string, before: DocumentSnapshot, after: DocumentSnapshot): void {
    this.#recordItem(name, { kind: "snapshot", before, after });
  }

  #recordItem(name: string, data: ItemData): void {
    this.history.record(this.#command(name, data));
  }

  /** The history command that restores `data` (DOC-HIS-02). It keeps `data` for checkpoints. */
  #command(name: string, data: ItemData): HistoryCommand {
    const command: HistoryCommand = {
      name,
      undo: () => this.#step(data, "before"),
      redo: () => this.#step(data, "after"),
      release: () => {
        this.#releaseItem(data);
      },
    };
    this.#items.set(command, data);
    return command;
  }

  #step(data: ItemData, side: "before" | "after"): Promise<void> {
    if (data.kind === "snapshot")
      return this.#restore(side === "before" ? data.before : data.after);
    return this.#restorePatch(data, side);
  }

  async #restorePatch(
    data: Extract<ItemData, { kind: "pixels" }>,
    side: "before" | "after",
  ): Promise<void> {
    const patch = side === "before" ? data.beforePatch : data.afterPatch;
    restoreTiles(data.layer.pixels, await this.#spill.get(patch));
    this.#selection = side === "before" ? data.selectionBefore : data.selectionAfter;
  }

  #releaseItem(data: ItemData): void {
    if (data.kind === "snapshot") {
      this.#releaseSnapshot(data.before);
      this.#releaseSnapshot(data.after);
      return;
    }
    this.#spill.release(data.beforePatch);
    this.#spill.release(data.afterPatch);
  }

  #releaseSnapshot(snapshot: DocumentSnapshot): void {
    for (const entry of snapshot.layers) {
      if (entry.pixels) this.#spill.release(entry.pixels);
    }
  }

  /**
   * Makes `target` the current state. Every pixel store is loaded before anything changes, so a
   * failure (for example out of memory) leaves the document as it was.
   */
  async #restore(target: DocumentSnapshot): Promise<void> {
    const loaded = new Map<LayerSnapshot, TiledPixelStore>();
    try {
      for (const entry of target.layers) {
        if (entry.pixels) {
          loaded.set(entry, await this.#loadPixels(entry.pixels, target.width, target.height));
        }
      }
    } catch (error) {
      for (const pixels of loaded.values()) pixels.dispose();
      throw error;
    }

    const kept = new Set(target.layers.map((entry) => entry.layer));
    for (const layer of this.#layers) {
      if (!kept.has(layer)) layer.dispose();
    }
    for (const entry of target.layers) {
      const pixels = loaded.get(entry);
      if (pixels) entry.layer.resizePixels(pixels).dispose();
      entry.layer.applyProperties(entry.properties);
      entry.layer.metadata.clear();
      for (const [name, value] of entry.metadata) entry.layer.metadata.set(name, value);
    }
    this.#layers = target.layers.map((entry) => entry.layer);
    this.#width = target.width;
    this.#height = target.height;
    this.#active = target.activeLayer;
    this.#selection = target.selection;
    this.#resolution = target.resolution;
  }

  async #loadPixels(handle: SpillHandle, width: number, height: number): Promise<TiledPixelStore> {
    const pixels = this.#newPixels(width, height);
    try {
      restoreTiles(pixels, await this.#spill.get(handle));
    } catch (error) {
      pixels.dispose();
      throw error;
    }
    return pixels;
  }

  #notify(change: DocumentChange = "state"): void {
    for (const listener of this.#listeners) listener(change);
  }
}

/**
 * The kind of a document notification. `"preview"` is a live preview that only rewrote layer pixels
 * (a stroke or an effect in progress, or the restore after one). `"selection"` is a live selection
 * preview, or the restore after one: only the selection changed, with no history. `"state"` is
 * everything else: edits, history, committed selections, layers and their properties.
 */
export type DocumentChange = "state" | "preview" | "selection";

const PASTE_SELECTION_NAMES: Record<SelectionCombineMode, MessageId> = {
  replace: "history.pasteSelection",
  union: "history.pasteSelectionAdd",
  exclude: "history.pasteSelectionSubtract",
  intersect: "history.pasteSelectionIntersect",
  xor: "history.pasteSelectionXor",
};

const FLIP_NAMES: Record<ImageAxis, MessageId> = {
  horizontal: "history.flipHorizontalAll",
  vertical: "history.flipVerticalAll",
};

const ROTATION_NAMES: Record<ImageRotation, MessageId> = {
  cw: "history.rotate90Cw",
  ccw: "history.rotate90Ccw",
  half: "history.rotate180All",
};

/** How long a checkpoint copies pixels before its pause (L10: slices by time). */
const CHECKPOINT_SLICE_MS = 8;

/**
 * The tile rows of a layer that hold pixels, with their blob names: the layer's id, the row and the
 * newest version of any tile in the row, so an edit renames only the rows it touched (L2).
 */
function pixelRows(layer: Layer): { readonly ty: number; readonly name: string }[] {
  const store = layer.pixels;
  const rows = new Set(store.allocatedTiles().map(({ ty }) => ty));
  return [...rows]
    .sort((a, b) => a - b)
    .map((ty) => {
      let version = 0;
      for (let tx = 0; tx < store.tilesX; tx++)
        version = Math.max(version, store.tileVersion(tx, ty));
      return { ty, name: layerRowBlobName(layer.id, ty, version) };
    });
}

/** One tile row of a store as a tile patch; its empty tiles are recorded as transparent. */
function captureRow(store: TiledPixelStore, ty: number): Uint8Array {
  return captureTiles(store, rect(0, ty * TILE_SIZE, store.width, TILE_SIZE));
}

/** A history snapshot's pixels, which are always one blob. */
function singleBlob(pixels: string | readonly string[]): string {
  if (typeof pixels === "string") return pixels;
  throw new CheckpointError("A history snapshot's pixels must be one blob.");
}

/** The state of a layer that its pixels do not change (see `LayerInfo`). */
function layerInfo(layer: Layer): LayerInfo {
  return {
    id: layer.id,
    properties: layer.properties,
    isBackground: layer.isBackground,
    ...(layer.rawBlendMode === undefined ? {} : { rawBlendMode: layer.rawBlendMode }),
    extras: encodeJson(layer.extras),
  };
}

function layerFromInfo(info: LayerInfo, pixels: TiledPixelStore): Layer {
  return new Layer(info.id, pixels, {
    ...info.properties,
    isBackground: info.isBackground,
    ...(info.rawBlendMode === undefined ? {} : { rawBlendMode: info.rawBlendMode }),
    extras: decodeJson(info.extras) as Record<string, unknown>,
  });
}

function sameResolution(a: Resolution, b: Resolution): boolean {
  return a.unit === b.unit && a.x === b.x && a.y === b.y;
}

/** DOC-LYR-02: "Layer {name}" names the one changed property; several changes read "Layer Properties". */
function propertyHistoryName(before: LayerProperties, after: LayerProperties): string {
  const changed = (Object.keys(PROPERTY_LABELS) as (keyof LayerProperties)[]).filter(
    (key) => before[key] !== after[key],
  );
  const [only] = changed;
  if (changed.length === 1 && only !== undefined) {
    return t("history.layer", { name: t(PROPERTY_LABELS[only]) });
  }
  return t("history.layerProperties");
}
