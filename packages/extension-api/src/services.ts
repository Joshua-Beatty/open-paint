import type { ColorF, ColorProfileId, ColorRgba8, Surface } from "@openpaint/document";
import type { MessageId } from "@openpaint/i18n";
import type { JsonValue, PropertyValues } from "@openpaint/properties";
import type { EffectSummary } from "./effects";
import type { EffectEnvironment } from "./environment";
import type { ByteSink, ByteSource, FileTypeDescriptor, FileTypeSummary } from "./file-types";
import type { EffectRenderer } from "./render";

/** Whether OpenPaint runs in a browser tab or as an installed app (EXT-05-01). */
export type RunMode = "browserTab" | "installedApp";

/** The active rendering backend (ARC-02-02). */
export type RenderBackend = "webgpu" | "cpu";

/** The GPU performance class of an adapter (ARC-02-04). */
export type PerformanceClass = "veryLow" | "low" | "good";

export interface AppInfo {
  readonly appVersion: string;
  readonly extensionApiVersion: string;
  readonly runMode: RunMode;
  readonly backend: RenderBackend;
}

export interface GpuInfo {
  readonly backend: RenderBackend;
  readonly adapterVendor?: string;
  readonly adapterArchitecture?: string;
  readonly performanceClass: PerformanceClass;
}

export interface PaletteInfo {
  readonly colors: readonly ColorF[];
  readonly colorProfile: ColorProfileId;
}

export interface VisualStyle {
  readonly canvasBackground: ColorRgba8;
  readonly checkerColors: readonly [ColorRgba8, ColorRgba8];
  readonly checkerSize: number;
  readonly theme: "light" | "dark";
}

/** An image read from or written to the clipboard. */
export interface ClipboardImage {
  readonly surface: Surface;
  /** Embedded only in formats that can carry a profile, such as PNG. */
  readonly colorProfile?: ColorProfileId;
}

export interface FilePickerOptions {
  readonly title: MessageId;
  readonly extensions: readonly string[];
  readonly allowAllFiles?: boolean;
}

export interface PickedFile {
  readonly name: string;
  readonly source: ByteSource;
}

export interface SaveDestination {
  readonly name: string;
  readonly sink: ByteSink;
}

export interface AppInfoService {
  info(): Promise<AppInfo>;
}

export interface BufferPoolService {
  rent(byteLength: number): Promise<Uint8Array>;
  giveBack(buffer: Uint8Array): Promise<void>;
}

export interface ClipboardService {
  readImage(): Promise<ClipboardImage | undefined>;
  writeImage(image: ClipboardImage): Promise<void>;
}

export interface GpuInfoService {
  info(): Promise<GpuInfo>;
}

export interface LocalizationService {
  language(): Promise<string>;
  /** The localized display name of a message, such as an enum value. */
  localize(id: MessageId): Promise<string>;
}

export interface ErrorDialogService {
  show(error: { readonly message: MessageId; readonly details?: string }): Promise<void>;
}

export interface PaletteService {
  defaultPalette(): Promise<PaletteInfo>;
  currentPalette(): Promise<PaletteInfo>;
}

/** Read-only access to app settings by path (for example `effects.defaultQualityGpu`). */
export interface SettingsService {
  read(path: string): Promise<JsonValue | undefined>;
}

export interface OpenLinkService {
  /** Opens the URL in a new tab after the user confirms. Resolves to whether it was opened. */
  open(url: string): Promise<boolean>;
}

export interface FileAccessService {
  pickFileToRead(options: FilePickerOptions): Promise<PickedFile | undefined>;
  pickSaveDestination(
    options: FilePickerOptions & { readonly suggestedName: string },
  ): Promise<SaveDestination | undefined>;
}

export interface VisualStylingService {
  style(): Promise<VisualStyle>;
}

export interface EffectsService {
  list(): Promise<readonly EffectSummary[]>;
  /** The renderer for an effect, or undefined when the engine binds it by id. */
  createRenderer(id: string, environment: EffectEnvironment): Promise<EffectRenderer | undefined>;
}

export interface FileTypesService {
  list(): Promise<readonly FileTypeSummary[]>;
  /** Decodes a file and returns its flattened RGBA bitmap. */
  loadFlattened(source: ByteSource): Promise<Surface>;
  /** The built-in JPEG or PNG file type. */
  builtin(id: "jpeg" | "png"): Promise<FileTypeDescriptor>;
  /** A save token for a built-in type: its defaults, overridden by `values`. */
  createSaveToken(id: "jpeg" | "png", values?: PropertyValues): Promise<PropertyValues>;
}

/** The DOC-IMG-02 resampling choices. */
export type ResampleFilter =
  | "nearest"
  | "bilinear"
  | "bilinearLowQuality"
  | "bicubic"
  | "bicubicSmooth"
  | "adaptive"
  | "lanczos3"
  | "superSampling"
  | "fant";

export interface QuantizeOptions {
  /** Palette size, from 2 to 256. */
  readonly paletteSize: number;
  readonly algorithm: "medianCut" | "octree";
  /** Dithering level from 0 (none) to 8 (strongest). */
  readonly ditherLevel: number;
}

export interface QuantizedImage {
  readonly width: number;
  readonly height: number;
  readonly palette: readonly ColorRgba8[];
  /** One palette index per pixel, row by row. */
  readonly indices: Uint8Array;
}

export interface TextLayoutRequest {
  readonly text: string;
  readonly fontFamily: string;
  /** Size in pixels. */
  readonly sizePx: number;
  readonly bold: boolean;
  readonly italic: boolean;
  /** Wrap width in pixels. Omitted means no wrapping. */
  readonly maxWidth?: number;
}

export interface TextLayoutLine {
  readonly text: string;
  readonly width: number;
  /** Distance from the top of the layout to this line's baseline. */
  readonly baseline: number;
}

export interface TextLayout {
  readonly width: number;
  readonly height: number;
  readonly lines: readonly TextLayoutLine[];
}

export interface ImagingService {
  resample(
    surface: Surface,
    width: number,
    height: number,
    filter: ResampleFilter,
  ): Promise<Surface>;
  quantize(surface: Surface, options: QuantizeOptions): Promise<QuantizedImage>;
  /** Shapes and lays out text with OpenPaint's text engine (WEB-FONT-03). */
  layoutText(request: TextLayoutRequest): Promise<TextLayout>;
}

/**
 * Host services (EXT-05-01). Built-ins and, later, plugins receive them. Every call is asynchronous
 * (EXT-V1-06), so the same contracts can later cross a worker boundary.
 */
export interface HostServices {
  readonly app: AppInfoService;
  readonly buffers: BufferPoolService;
  readonly clipboard: ClipboardService;
  readonly gpu: GpuInfoService;
  readonly localization: LocalizationService;
  readonly errors: ErrorDialogService;
  readonly palettes: PaletteService;
  readonly settings: SettingsService;
  readonly links: OpenLinkService;
  readonly files: FileAccessService;
  readonly styling: VisualStylingService;
  readonly effects: EffectsService;
  readonly fileTypes: FileTypesService;
  readonly imaging: ImagingService;
}
