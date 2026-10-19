import { DEFAULT_LAYER_BLEND_MODE, isLayerBlendMode, type LayerBlendMode } from "./blend-mode";
import type { LayerFloatPreview } from "./float-preview";
import type { Rect } from "./geometry";
import type { LayerOverlay } from "./layer-overlay";
import { MetadataMap } from "./metadata";
import type { TiledPixelStore } from "./tiled-store";

/** DOC-LYR-01: names are at most 256 characters. */
export const MAX_LAYER_NAME_LENGTH = 256;
/** DOC-LYR-01: opacity is a byte. */
export const MIN_LAYER_OPACITY = 0;
export const MAX_LAYER_OPACITY = 255;
export const DEFAULT_LAYER_OPACITY = MAX_LAYER_OPACITY;

/** The user-editable properties of a layer (DOC-LYR-01). */
export interface LayerProperties {
  readonly name: string;
  readonly visible: boolean;
  readonly opacity: number;
  readonly blendMode: LayerBlendMode;
}

/** Truncates a name to `MAX_LAYER_NAME_LENGTH` characters (code points). */
export function truncateLayerName(name: string): string {
  return Array.from(name).slice(0, MAX_LAYER_NAME_LENGTH).join("");
}

/**
 * Checks and normalizes a partial property set. Names are truncated, and out-of-range opacity or
 * unknown blend modes throw, since they can only come from a caller bug.
 */
export function normalizeLayerProperties(
  patch: Partial<LayerProperties>,
): Partial<LayerProperties> {
  const out: { -readonly [K in keyof LayerProperties]?: LayerProperties[K] } = {};
  if (patch.name !== undefined) {
    if (typeof patch.name !== "string") throw new TypeError("Layer name must be a string.");
    out.name = truncateLayerName(patch.name);
  }
  if (patch.visible !== undefined) {
    if (typeof patch.visible !== "boolean")
      throw new TypeError("Layer visibility must be a boolean.");
    out.visible = patch.visible;
  }
  if (patch.opacity !== undefined) {
    const opacity = patch.opacity;
    if (!Number.isInteger(opacity) || opacity < MIN_LAYER_OPACITY || opacity > MAX_LAYER_OPACITY) {
      throw new RangeError(`Layer opacity must be an integer from 0 to 255, got ${opacity}.`);
    }
    out.opacity = opacity;
  }
  if (patch.blendMode !== undefined) {
    if (!isLayerBlendMode(patch.blendMode)) {
      throw new RangeError(`Unknown layer blend mode ${String(patch.blendMode)}.`);
    }
    out.blendMode = patch.blendMode;
  }
  return out;
}

export interface LayerInit extends LayerProperties {
  readonly isBackground?: boolean;
  /** The blend mode value a file stored when it is not a known mode (FMT-NAT-09). */
  readonly rawBlendMode?: number;
  /** Keys a file format did not recognize, kept for the next save (FMT-NAT-07). */
  readonly extras?: Readonly<Record<string, unknown>>;
}

/**
 * A raster layer: the same size as its document, with pixels in a tiled RGBA8 store and the
 * properties of DOC-LYR-01. Its blend mode and opacity apply only when compositing (DOC-LYR-01).
 * Mutate layers through `Document`, which records dirty state and notifies listeners.
 */
export class Layer {
  readonly id: number;
  /** True only for the initial background layer (DOC-LYR-01). */
  readonly isBackground: boolean;
  /** Per-layer user metadata items (DOC-DOC-04). */
  readonly metadata = new MetadataMap<string>();
  /** Keys a file format did not recognize. Kept with the layer through copies (FMT-NAT-07). */
  readonly extras: Readonly<Record<string, unknown>>;
  #pixels: TiledPixelStore;
  #name: string;
  #visible: boolean;
  #opacity: number;
  #blendMode: LayerBlendMode;
  #rawBlendMode: number | undefined;
  #livePreview: LayerLivePreview | undefined;
  #floatPreview: LayerFloatPreview | undefined;
  #overlay: LayerOverlay | undefined;

  constructor(id: number, pixels: TiledPixelStore, init: LayerInit) {
    const normalized = normalizeLayerProperties(init);
    this.id = id;
    this.#pixels = pixels;
    this.extras = init.extras ?? {};
    this.#rawBlendMode = init.rawBlendMode;
    this.isBackground = init.isBackground ?? false;
    this.#name = normalized.name ?? "";
    this.#visible = normalized.visible ?? true;
    this.#opacity = normalized.opacity ?? DEFAULT_LAYER_OPACITY;
    this.#blendMode = normalized.blendMode ?? DEFAULT_LAYER_BLEND_MODE;
  }

  get name(): string {
    return this.#name;
  }

  get visible(): boolean {
    return this.#visible;
  }

  get opacity(): number {
    return this.#opacity;
  }

  get blendMode(): LayerBlendMode {
    return this.#blendMode;
  }

  /**
   * The blend mode value a file stored when it was not a known mode. It is written back on save
   * until the user sets the blend mode (FMT-NAT-09). Undefined for a known mode.
   */
  get rawBlendMode(): number | undefined {
    return this.#rawBlendMode;
  }

  get pixels(): TiledPixelStore {
    return this.#pixels;
  }

  get properties(): LayerProperties {
    return {
      name: this.#name,
      visible: this.#visible,
      opacity: this.#opacity,
      blendMode: this.#blendMode,
    };
  }

  /** Applies validated changes and reports whether any value differed. Called by `Document`. */
  applyProperties(patch: Partial<LayerProperties>): boolean {
    const next = normalizeLayerProperties(patch);
    const before = this.properties;
    this.#name = next.name ?? this.#name;
    this.#visible = next.visible ?? this.#visible;
    this.#opacity = next.opacity ?? this.#opacity;
    this.#blendMode = next.blendMode ?? this.#blendMode;
    if (next.blendMode !== undefined) this.#rawBlendMode = undefined;
    const after = this.properties;
    return (
      before.name !== after.name ||
      before.visible !== after.visible ||
      before.opacity !== after.opacity ||
      before.blendMode !== after.blendMode
    );
  }

  /**
   * Swaps in a same-sized pixel store and returns the previous one, which the caller now owns.
   * Called by `Document` for whole-layer operations such as flips and merges.
   */
  replacePixels(next: TiledPixelStore): TiledPixelStore {
    if (next.width !== this.#pixels.width || next.height !== this.#pixels.height) {
      throw new RangeError("Replacement pixels must match the layer size.");
    }
    const previous = this.#pixels;
    this.#pixels = next;
    return previous;
  }

  /**
   * Swaps in pixels of any size and returns the previous store, which the caller now owns. Only
   * whole-document operations that change the canvas size (Crop, Resize, Canvas Size, rotations)
   * use it.
   */
  resizePixels(next: TiledPixelStore): TiledPixelStore {
    const previous = this.#pixels;
    this.#pixels = next;
    return previous;
  }

  /**
   * The per-pixel adjustment the canvas shows over this layer while its dialog previews it, or
   * undefined. The pixels stay as they are. Set through `Document.setLayerLivePreview`.
   */
  get livePreview(): LayerLivePreview | undefined {
    return this.#livePreview;
  }

  /** Called by `Document`. */
  setLivePreview(preview: LayerLivePreview | undefined): void {
    this.#livePreview = preview;
  }

  /**
   * The floating content the canvas draws over this layer's pixels while Move Selected Pixels
   * previews a transform, or undefined. The pixels stay as they are. Set through
   * `Document.setLayerFloatPreview`.
   */
  get floatPreview(): LayerFloatPreview | undefined {
    return this.#floatPreview;
  }

  /** Called by `Document`. */
  setFloatPreview(preview: LayerFloatPreview | undefined): void {
    this.#floatPreview = preview;
  }

  /**
   * A pending tool result shown over this layer's pixels, or undefined (TL-FRAME-01). The pixels
   * stay as they are. Set through `Document.setLayerOverlay`.
   */
  get overlay(): LayerOverlay | undefined {
    return this.#overlay;
  }

  /** Called by `Document`. */
  setOverlay(overlay: LayerOverlay | undefined): void {
    this.#overlay = overlay;
  }

  /** Frees the layer's pixel memory. The layer must not be used afterwards. */
  dispose(): void {
    this.#pixels.dispose();
  }
}

/**
 * A per-pixel adjustment that the canvas applies to a layer's pixels as it draws them, so a dialog
 * can preview it without writing the layer (FX-FW-PREVIEW-01). The document stores it as data: the
 * canvas resolves `effectId` to the adjustment and reads `params`, which must be structured-cloneable.
 */
export interface LayerLivePreview {
  readonly effectId: string;
  readonly params: unknown;
  /** The part of the layer the adjustment covers, in layer pixels. */
  readonly region: Rect;
  /** The selection's coverage over `region`, one byte per pixel, or undefined for all of it. */
  readonly coverage: Uint8Array | undefined;
}
