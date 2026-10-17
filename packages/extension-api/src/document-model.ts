import type {
  ColorProfileId,
  FormatExtras,
  Resolution,
  SelectionPolygon,
  SelectionQuality,
  Surface,
} from "@openpaint/document";

/** A blend mode value from DOC-BLD-01 (0 Normal through 13 Xor). */
export type BlendModeId = number;

/** Document metadata sections (DOC-DOC-04). */
export interface DocumentMetadata {
  /** One TIFF-structured EXIF block, without the `Exif\0\0` prefix. */
  readonly exif?: Uint8Array;
  /** XMP packets in order, each UTF-8 XML. */
  readonly xmp: readonly string[];
  /** IPTC-IIM records. */
  readonly iptc?: Uint8Array;
  /** User key/value metadata (the `$user` section). */
  readonly user: Readonly<Record<string, string>>;
}

/** A raster layer as file types see it (EXT-07-06). */
export interface BitmapLayer {
  readonly name: string;
  readonly visible: boolean;
  /** Opacity in 0-255. */
  readonly opacity: number;
  readonly blendMode: BlendModeId;
  readonly surface: Surface;
  /** Native format: the layer is the background layer (DOC-LYR-01). */
  readonly isBackground?: boolean;
  /** Native format: per-layer user metadata (DOC-DOC-04). */
  readonly metadata?: Readonly<Record<string, string>>;
  /** Native format: a blend mode value that is not a known mode, written back until it is changed. */
  readonly rawBlendMode?: number;
  /** Native format: keys the file did not recognize, kept with the layer (FMT-NAT-07). */
  readonly extras?: Readonly<Record<string, unknown>>;
  /** Native format: the pixels could not be read, so the layer loads transparent (FMT-NAT-09). */
  readonly damaged?: boolean;
}

/** The document selection a layered file stores (DOC-SEL-01, DOC-SEL-03). */
export interface FileSelection {
  readonly polygons: readonly SelectionPolygon[];
  readonly quality: SelectionQuality;
}

/** The document model that file types load into and save from (EXT-07-06). */
export interface FileDocument {
  readonly width: number;
  readonly height: number;
  readonly resolution: Resolution;
  readonly colorProfile: ColorProfileId;
  readonly metadata: DocumentMetadata;
  /** Layers, bottom to top. */
  readonly layers: readonly BitmapLayer[];
  /**
   * Catalog keys of non-blocking warnings from the load, such as an embedded color profile that was
   * ignored (FMT-META-03). The app shows them after the image opens.
   */
  readonly warnings?: readonly string[];
  /** Layered formats: the selection (DOC-SEL-01). Absent means nothing is selected. */
  readonly selection?: FileSelection;
  /** Layered formats: index of the active layer (DOC-LYR-05p). */
  readonly activeLayer?: number;
  /** Layered formats: keys and entries the format did not recognize, written back on save. */
  readonly extras?: FormatExtras;
  /** Layered formats: the preview thumbnail (FMT-NAT-06), written on save. */
  readonly thumbnail?: Surface;
  /** Layered formats: the load changed the document, so it opens with unsaved changes. */
  readonly dirty?: boolean;
}
