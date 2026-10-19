import type { LayerProperties } from "./layer";
import type { MetadataMap, MetadataStore } from "./metadata";
import type { ColorProfileId } from "./pixel-format";
import type { Resolution } from "./resolution";
import { Selection } from "./selection";
import type { AffineMatrix, SelectionPolygon, SelectionQuality } from "./selection-polygons";

/** Marks a checkpoint manifest as ours (WEB-MEM-05). */
export const CHECKPOINT_FORMAT = "openpaint-checkpoint";
/** The checkpoint layout. A reader refuses any other version. */
export const CHECKPOINT_VERSION = 1;

/** Raised when a checkpoint cannot be read back, so the caller can skip it. */
export class CheckpointError extends Error {
  override readonly name = "CheckpointError";
}

const BYTES_KEY = "$bytes";

/**
 * A checkpoint of one document (WEB-MEM-05): a JSON manifest plus the binary blobs it names. Pixel
 * data and history data are blobs, so the manifest stays plain JSON.
 */
export interface DocumentCheckpoint {
  readonly manifest: DocumentCheckpointManifest;
  readonly blobs: ReadonlyMap<string, Uint8Array>;
  /**
   * Blobs the manifest names that are left out of `blobs`, because the caller said it holds them
   * already (`Document.checkpoint`'s `known`). A blob's name changes whenever its content does.
   */
  readonly reused?: readonly string[];
}

export interface DocumentCheckpointManifest {
  readonly format: typeof CHECKPOINT_FORMAT;
  readonly version: typeof CHECKPOINT_VERSION;
  readonly width: number;
  readonly height: number;
  readonly resolution: Resolution;
  readonly colorProfile: ColorProfileId;
  readonly metadata: CheckpointMetadata;
  readonly formatExtras: unknown;
  readonly nextLayerId: number;
  readonly activeLayerId: number | null;
  readonly selection: CheckpointSelection;
  /** The current layers, bottom to top. Each has its pixels in a blob. */
  readonly layers: readonly CheckpointLayer[];
  readonly history: {
    /** Applied items, oldest first, then the undone items in the order they were undone. */
    readonly items: readonly CheckpointItem[];
    readonly appliedCount: number;
    readonly saved: { readonly depth: number; readonly index: number };
  };
}

/** Layer state that does not change with its pixels. A history item may name a layer that is gone. */
export interface LayerInfo {
  readonly id: number;
  readonly properties: LayerProperties;
  readonly isBackground: boolean;
  readonly rawBlendMode?: number;
  readonly extras: unknown;
}

export interface CheckpointLayer extends LayerInfo {
  /** Layer metadata entries, as `[name, value]` pairs with encoded values. */
  readonly metadata: readonly (readonly [string, unknown])[];
  /**
   * The layer's pixels: for the document's layers, one blob per tile row that holds pixels
   * (`layerRowBlobName`), or one blob for the whole layer in older checkpoints; for a history
   * snapshot, one blob, omitted when the layer keeps its pixels.
   */
  readonly pixels?: string | readonly string[];
}

export interface CheckpointSnapshot {
  readonly width: number;
  readonly height: number;
  readonly resolution: Resolution;
  readonly activeLayerId: number | null;
  readonly selection: CheckpointSelection;
  readonly layers: readonly CheckpointLayer[];
}

export type CheckpointItem =
  | { readonly kind: "base"; readonly name: string }
  | { readonly kind: "compound"; readonly name: string; readonly items: readonly CheckpointItem[] }
  | {
      readonly kind: "snapshot";
      readonly name: string;
      readonly before: CheckpointSnapshot;
      readonly after: CheckpointSnapshot;
    }
  | {
      readonly kind: "pixels";
      readonly name: string;
      readonly layer: LayerInfo;
      /** Tile patches of the layer before and after the edit (DOC-HIS-02). */
      readonly beforePatch: string;
      readonly afterPatch: string;
      readonly selectionBefore: CheckpointSelection;
      readonly selectionAfter: CheckpointSelection;
    }
  | {
      /** A tool's Finish, which keeps only the pixels it overwrote (`editLayerPixelsRendered`). */
      readonly kind: "rendered";
      readonly name: string;
      readonly layer: LayerInfo;
      readonly beforePatch: string;
      readonly selectionBefore: CheckpointSelection;
      readonly selectionAfter: CheckpointSelection;
    }
  /** A step that changed only a tool's pending state (`History.recordStep`). */
  | { readonly kind: "step"; readonly name: string };

export interface CheckpointSelection {
  readonly polygons: readonly SelectionPolygon[];
  readonly quality: SelectionQuality;
  readonly pendingTransform?: AffineMatrix;
}

export interface CheckpointMetadata {
  readonly exif: readonly (readonly [string, unknown])[];
  readonly iptc: readonly (readonly [string, unknown])[];
  readonly xmp: readonly (readonly [string, unknown])[];
  readonly user: readonly (readonly [string, unknown])[];
  readonly xmlHeader?: string;
}

/** Bytes become `{ "$bytes": base64 }`, so the value survives JSON. */
export function encodeJson(value: unknown): unknown {
  if (value instanceof Uint8Array) return { [BYTES_KEY]: toBase64(value) };
  if (Array.isArray(value)) return value.map(encodeJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeJson(item)]));
  }
  return value;
}

/** Inverse of `encodeJson`. */
export function decodeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeJson);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const bytes = record[BYTES_KEY];
    if (Object.keys(record).length === 1 && typeof bytes === "string") return fromBase64(bytes);
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, decodeJson(item)]));
  }
  return value;
}

export function metadataEntries(
  map: MetadataMap<string | Uint8Array>,
): (readonly [string, unknown])[] {
  return [...map.entries()].map(([name, value]) => [name, encodeJson(value)] as const);
}

export function metadataJson(store: MetadataStore): CheckpointMetadata {
  return {
    exif: metadataEntries(store.exif),
    iptc: metadataEntries(store.iptc),
    xmp: metadataEntries(store.xmp),
    user: metadataEntries(store.user),
    ...(store.xmlHeader === undefined ? {} : { xmlHeader: store.xmlHeader }),
  };
}

export function applyMetadataJson(store: MetadataStore, json: CheckpointMetadata): void {
  for (const [name, value] of json.exif)
    store.exif.set(name, decodeJson(value) as Uint8Array | string);
  for (const [name, value] of json.iptc)
    store.iptc.set(name, decodeJson(value) as Uint8Array | string);
  for (const [name, value] of json.xmp)
    store.xmp.set(name, decodeJson(value) as Uint8Array | string);
  for (const [name, value] of json.user) store.user.set(name, decodeJson(value) as string);
  store.xmlHeader = json.xmlHeader;
}

export function selectionJson(selection: Selection): CheckpointSelection {
  return {
    polygons: selection.polygons.map((polygon) => [...polygon]),
    quality: selection.quality,
    ...(selection.pendingTransform === undefined
      ? {}
      : { pendingTransform: { ...selection.pendingTransform } }),
  };
}

export function selectionFromJson(json: CheckpointSelection): Selection {
  return new Selection(json.polygons, json.quality, json.pendingTransform);
}

/**
 * The blob name of one tile row of a layer: its id, the row and the newest tile version in the row.
 * Any change to a tile of the row gives that tile a version newer than every other, so a name
 * stands for one content, and a row the last edits did not touch keeps its name (L2).
 */
export function layerRowBlobName(id: number, row: number, version: number): string {
  return `layer-${id}-r${row}-v${version}`;
}

/** The blob name of spilled history data, which never changes once spilled. */
export function historyBlobName(handleId: number): string {
  return `history-${handleId}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
