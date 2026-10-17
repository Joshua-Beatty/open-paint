import type { Surface } from "@openpaint/document";
import type { FileCodec, FileDocument, FileTypeDescriptor } from "@openpaint/extension-api";
import type { Translate } from "@openpaint/i18n";
import type { PropertyValues } from "@openpaint/properties";

/** What the Save Configuration preview shows (FMT-UI-02, FMT-UI-03). */
export type PreviewState =
  | { readonly kind: "computing"; readonly percent: number }
  | { readonly kind: "ready"; readonly bytes: Uint8Array<ArrayBuffer>; readonly image: Surface }
  | { readonly kind: "error" };

/** Thrown from the progress callback of a computation that a newer change has superseded. */
class SupersededPreview extends Error {
  override readonly name = "SupersededPreview";
}

/**
 * Encodes the flattened image with each set of options, and shows the result (FMT-UI-03). The
 * encoded length is the file size. A lossy type that can be loaded is decoded again, so the preview
 * shows its artifacts; otherwise the original image is shown. A newer change supersedes the
 * computation in flight: its progress callback throws, and any result it still produces is dropped.
 */
export class SavePreview {
  readonly #codec: FileCodec;
  readonly #type: FileTypeDescriptor;
  readonly #file: FileDocument;
  readonly #original: Surface;
  readonly #listeners = new Set<() => void>();
  #generation = 0;
  #state: PreviewState = { kind: "computing", percent: 0 };
  #pending: Promise<void> = Promise.resolve();

  constructor(codec: FileCodec, type: FileTypeDescriptor, file: FileDocument) {
    const layer = file.layers[0];
    if (layer === undefined) throw new RangeError("A preview needs an image.");
    this.#codec = codec;
    this.#type = type;
    this.#file = file;
    this.#original = layer.surface;
  }

  get state(): PreviewState {
    return this.#state;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Starts the computation for these values, superseding any earlier one. */
  update(values: PropertyValues): void {
    const generation = ++this.#generation;
    this.#set({ kind: "computing", percent: 0 });
    this.#pending = this.#compute(values, generation);
  }

  /** Resolves with the state once the latest values have been computed. */
  async settled(): Promise<PreviewState> {
    await this.#pending;
    return this.#state;
  }

  /** Supersedes the computation in flight, for when the dialog closes. */
  cancel(): void {
    this.#generation += 1;
  }

  async #compute(values: PropertyValues, generation: number): Promise<void> {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    const current = (): boolean => generation === this.#generation;
    try {
      await this.#codec.save(
        this.#file,
        {
          write: async (chunk) => {
            chunks.push(new Uint8Array(chunk));
          },
        },
        values,
        (fraction) => {
          if (!current()) throw new SupersededPreview();
          this.#set({ kind: "computing", percent: Math.round(fraction * 100) });
        },
      );
    } catch {
      if (current()) this.#set({ kind: "error" });
      return;
    }
    if (!current()) return;
    const bytes = concatenate(chunks);
    const image = await this.#previewImage(values, bytes);
    if (current()) this.#set({ kind: "ready", bytes, image });
  }

  /** The image the preview shows: the decoded bytes for a lossy type, else the original. */
  async #previewImage(values: PropertyValues, bytes: Uint8Array<ArrayBuffer>): Promise<Surface> {
    if (this.#type.isLossless(values) || !this.#type.capabilities.supportsLoading) {
      return this.#original;
    }
    try {
      const decoded = await this.#codec.load({
        byteLength: bytes.byteLength,
        readAll: async () => bytes,
      });
      return decoded.layers[0]?.surface ?? this.#original;
    } catch {
      return this.#original;
    }
  }

  #set(state: PreviewState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

function concatenate(chunks: readonly Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(
    new ArrayBuffer(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)),
  );
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const KIBIBYTE = 1024;

/** A file size for the preview header (FMT-UI-02): bytes, KB, MB or GB, one decimal at most. */
export function fileSizeText(bytes: number, t: Translate): string {
  if (bytes < KIBIBYTE) return t("file.size.bytes", { size: bytes });
  if (bytes < KIBIBYTE ** 2) return t("file.size.kilobytes", { size: round(bytes / KIBIBYTE) });
  if (bytes < KIBIBYTE ** 3)
    return t("file.size.megabytes", { size: round(bytes / KIBIBYTE ** 2) });
  return t("file.size.gigabytes", { size: round(bytes / KIBIBYTE ** 3) });
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** The size part of the preview header: the size, a computing percentage, or an error. */
export function previewSizeText(state: PreviewState, t: Translate): string {
  switch (state.kind) {
    case "computing":
      return state.percent > 0
        ? t("file.saveConfig.computingPercent", { percent: state.percent })
        : t("file.saveConfig.computing");
    case "ready":
      return fileSizeText(state.bytes.byteLength, t);
    case "error":
      return t("file.saveConfig.error");
  }
}
