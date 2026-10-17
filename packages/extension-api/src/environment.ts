import type {
  ColorF,
  ColorProfileId,
  ColorRgba8,
  PixelFormat,
  Rect,
  Resolution,
  Surface,
} from "@openpaint/document";
import type { BlendModeId, DocumentMetadata } from "./document-model";

/** One layer as an effect sees it (EXT-04-02). */
export interface EffectLayerView {
  readonly name: string;
  readonly visible: boolean;
  /** Opacity in [0, 1]. */
  readonly opacity: number;
  readonly blendMode: BlendModeId;
  /** The raw layer content. Opacity and blend mode are not applied. */
  getBitmap(format: PixelFormat): Surface;
}

/** The document as an effect sees it (EXT-04-01). */
export interface EffectDocumentView {
  readonly width: number;
  readonly height: number;
  readonly resolution: Resolution;
  readonly metadata: DocumentMetadata;
  readonly colorProfile: ColorProfileId;
  readonly layers: readonly EffectLayerView[];
  /** The flattened composite, with blend mode, opacity and visibility applied. */
  getBitmap(format: PixelFormat): Surface;
}

/** The selection as an effect sees it (EXT-04-04). With no selection, it is the whole canvas. */
export interface EffectSelection {
  readonly renderBounds: Rect;
  /** Rectangles sorted top to bottom, then left to right. */
  readonly renderScans: readonly Rect[];
  /** Polygons in canvas pixels, each flat as `[x0, y0, x1, y1, …]`, clipped to the canvas. */
  readonly geometry: readonly (readonly number[])[];
  /** 8-bit coverage (0 = none, 255 = full) over `renderBounds`, row by row. */
  readonly mask: Uint8Array;
}

/** Values an environment can be cloned with (EXT-04-08). */
export interface EnvironmentOverrides {
  readonly primaryColor?: ColorRgba8;
  readonly secondaryColor?: ColorRgba8;
  readonly brushSize?: number;
  /** Replaces the source layer's pixels for this environment. */
  readonly sourceSurface?: Surface;
  /** Forces an aliased selection mask. */
  readonly aliasedSelection?: boolean;
}

/** The environment that a configurable effect receives (EXT-04). */
export interface EffectEnvironment {
  readonly document: EffectDocumentView;
  /** Index into `document.layers` of the user's selected layer (EXT-04-03). */
  readonly sourceLayerIndex: number;
  readonly selection: EffectSelection;
  /** The user's palette colors in the document color space (EXT-04-05). */
  readonly primaryColor: ColorRgba8;
  readonly secondaryColor: ColorRgba8;
  readonly primaryFloatColor: ColorF;
  readonly secondaryFloatColor: ColorF;
  /** The current brush width from the toolbar (EXT-04-06). */
  readonly brushSize: number;
  /** The source layer's pixels in the requested format. */
  sourceBitmap(format: PixelFormat): Surface;
  /** A copy of this environment with some values replaced (EXT-04-08). */
  withOverrides(overrides: EnvironmentOverrides): EffectEnvironment;
}

/** The reduced environment for CPU region effects (EXT-04-09). */
export interface SimpleEffectEnvironment {
  readonly primaryColor: ColorRgba8;
  readonly secondaryColor: ColorRgba8;
  readonly brushSize: number;
  readonly sourceSurface: Surface;
  /** The selection clipped to `rect`. */
  getSelection(rect: Rect): EffectSelection;
}
