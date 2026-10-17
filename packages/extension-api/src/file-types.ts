import type { MessageId } from "@openpaint/i18n";
import { defaultValues, type PropertySchema, type PropertyValues } from "@openpaint/properties";
import type { IconId, ProgressReporter } from "./common";
import type { FileDocument } from "./document-model";
import type { HostServices } from "./services";

/** A source of file bytes for a decoder. */
export interface ByteSource {
  readonly byteLength: number;
  readAll(): Promise<Uint8Array>;
}

/** A destination for encoded bytes. The encoder writes only after encoding succeeds (FMT-SAVE-03). */
export interface ByteSink {
  write(chunk: Uint8Array): Promise<void>;
}

/** Capability flags of a file type (EXT-07-01, FMT-REG-06). */
export interface FileTypeCapabilities {
  readonly supportsLayers: boolean;
  readonly supportsCustomHeaders: boolean;
  readonly supportsSaving: boolean;
  readonly supportsLoading: boolean;
  readonly savesWithProgress: boolean;
  /** The save may be canceled, for example from a progress callback that throws. */
  readonly supportsCancellation: boolean;
}

/** The codec module of a file type. It is lazy-loaded on first use (EXT-09-04, FMT-REG-07). */
export interface FileCodec {
  /** Decodes the first frame or page into the document model (EXT-07-02). */
  load(source: ByteSource): Promise<FileDocument>;
  /** Encodes the document with a save token (EXT-07-02). */
  save(
    document: FileDocument,
    sink: ByteSink,
    token: PropertyValues,
    progress: ProgressReporter,
  ): Promise<void>;
}

/** A file type (EXT-07-01). Load-only types such as DDS omit the save fields. */
export interface FileTypeDescriptor {
  readonly id: string;
  /** The major API version this descriptor targets (EXT-02-13). */
  readonly apiVersion: number;
  /** Display name, such as "PNG" (EXT-07-01). */
  readonly label: MessageId;
  readonly icon: IconId;
  /** Dot-prefixed, lowercase load extensions. */
  readonly loadExtensions: readonly string[];
  /** Dot-prefixed, lowercase save extensions. The first one is the default. */
  readonly saveExtensions: readonly string[];
  readonly mimeTypes: readonly string[];
  readonly capabilities: FileTypeCapabilities;
  /** Save options (EXT-06). Its defaults make up the default save token. */
  readonly saveOptions: PropertySchema;
  readonly loadCodec: () => Promise<FileCodec>;
  /** Whether a save followed by a load gives identical pixels (EXT-07-03). */
  readonly isLossless: (token: PropertyValues) => boolean;
  /**
   * Recognizes the file by its first bytes (FMT-OPEN-02 content sniffing). It is asked when the
   * extension is unknown or the declared type cannot decode the file. Types without a signature omit it.
   */
  readonly sniff?: (bytes: Uint8Array) => boolean;
}

/** What the host gives a file type factory (EXT-07-05). */
export interface FileTypeHost {
  readonly services: HostServices;
}

/** The entry point of a file-type module: returns one or more file types (EXT-07-05). */
export type FileTypeFactory = (host: FileTypeHost) => readonly FileTypeDescriptor[];

/** A file type without its codec and save hooks, safe to list (EXT-05-01). */
export type FileTypeSummary = Omit<FileTypeDescriptor, "loadCodec" | "isLossless" | "saveOptions">;

/** The save token a file type starts from: its schema defaults (EXT-07-02). */
export function defaultSaveToken(type: FileTypeDescriptor): PropertyValues {
  return defaultValues(type.saveOptions);
}
