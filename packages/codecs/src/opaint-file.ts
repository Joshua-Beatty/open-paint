import {
  DEFAULT_RESOLUTION,
  type FormatExtras,
  isLayerBlendMode,
  isValidImageSize,
  isValidResolution,
  LayerBlendMode,
  MAX_RESOLUTION,
  MIN_RESOLUTION,
  OutOfMemoryError,
  type Resolution,
  resampleSurface,
  type SelectionPolygon,
  type SelectionQuality,
  Surface,
  truncateLayerName,
} from "@openpaint/document";
import type { BitmapLayer, FileDocument } from "@openpaint/extension-api";

type FileSelection = NonNullable<FileDocument["selection"]>;

import { ProfileError, profileSpace } from "./color-engine";
import { convertRgbaToSrgb, PROFILE_IGNORED_WARNING } from "./icc-transform";
import { encodePngAsync } from "./png";
import { decodePngPixels } from "./png-raster";
import { straightRgba } from "./raster-document";
import {
  isSafeEntryPath,
  writeZip,
  ZipArchive,
  type ZipEntry,
  ZipError,
  type ZipInput,
} from "./zip";
import { deflateZlib } from "./zlib";

/**
 * The native `.opaint` format (FMT-NAT). A ZIP package with a `document.json` manifest, one PNG per
 * layer, a thumbnail and optional metadata entries. The reader checks the file in the FMT-NAT-09
 * order and loads damaged layers blank. The writer keeps the keys and entries it did not recognize.
 */

export const OPAINT_MIME = "image/x-openpaint";
/** The format version this build writes (FMT-NAT-04). */
export const OPAINT_FORMAT_VERSION = 1;
/** The highest format version this build reads (FMT-NAT-08). */
export const OPAINT_READER_VERSION = 1;
const GENERATOR = "OpenPaint";

const MIMETYPE = "mimetype";
const DOCUMENT_JSON = "document.json";
const THUMBNAIL = "thumbnail.png";
const EXIF = "metadata/exif.bin";
const IPTC = "metadata/iptc.bin";
const CUSTOM = "metadata/custom.json";
const THUMBNAIL_MAX_SIZE = 256;
const MIMETYPE_MAX_BYTES = 256;
const DOCUMENT_JSON_MAX_BYTES = 16 * 1024 * 1024;
const METADATA_MAX_BYTES = 64 * 1024 * 1024;
const PROFILE_MAX_BYTES = 4 * 1024 * 1024;
const EXTRA_ENTRIES = 1024;
const RGBA_CHANNELS = 4;
const PNG_SIGNATURE_BYTES = 8;
const PNG_IHDR_END = 24;
/** Slack for PNG chunk framing when a layer's stored size is bounded. */
const PNG_OVERHEAD_BYTES = 64 * 1024;
const MAX_OPACITY = 255;
const RESOLUTION_UNITS = ["pixel", "inch", "centimeter"] as const;

/** Catalog keys of the non-blocking warnings the reader raises (FMT-NAT-07, FMT-NAT-08, FMT-NAT-09). */
export const OPAINT_WARNINGS = {
  newerVersion: "file.warning.newerVersion",
  mimetype: "file.warning.mimetype",
  resolution: "file.warning.resolution",
  selection: "file.warning.selection",
  entrySkipped: "file.warning.entrySkipped",
  profileConverted: "file.warning.profileConverted",
  profileIgnored: PROFILE_IGNORED_WARNING,
} as const;

/**
 * A native file that cannot be opened. `corrupt` is FMT-NAT-09's corrupt file, `newerReader` is a file
 * that needs a newer OpenPaint (FMT-NAT-08), and `unrecognized` is a file with another `mimetype`.
 */
export class OpaintFormatError extends Error {
  override readonly name = "OpaintFormatError";

  constructor(
    readonly reason: "corrupt" | "newerReader" | "unrecognized",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface OpaintReadOptions {
  /** The bytes a load may allocate for its layers (FMT-NAT-10, WEB-MEM-03). */
  readonly memoryBudgetBytes: number;
}

type JsonObject = Record<string, unknown>;

const DOCUMENT_KEYS = new Set([
  "format",
  "formatVersion",
  "minReaderVersion",
  "generator",
  "width",
  "height",
  "resolution",
  "colorProfile",
  "metadata",
  "thumbnail",
  "layers",
  "activeLayer",
  "selection",
]);
const RESOLUTION_KEYS = new Set(["x", "y", "unit"]);
const METADATA_KEYS = new Set(["exif", "xmp", "iptc", "custom"]);
const LAYER_KEYS = new Set([
  "name",
  "visible",
  "opacity",
  "blendMode",
  "isBackground",
  "src",
  "metadata",
]);

/** A layer record of the manifest, with its defaults applied (FMT-NAT-04). */
interface ManifestLayer {
  readonly name: string;
  readonly visible: boolean;
  readonly opacity: number;
  readonly blendMode: LayerBlendMode;
  readonly rawBlendMode: number | undefined;
  readonly isBackground: boolean;
  readonly src: string;
  readonly metadata: Readonly<Record<string, string>> | undefined;
  readonly extras: Readonly<Record<string, unknown>>;
}

/**
 * Reads a `.opaint` file into the file model. The checks run in the FMT-NAT-09 order. A layer whose
 * picture cannot be read loads transparent and is flagged `damaged`, so the app can ask first.
 */
export async function readOpaint(
  bytes: Uint8Array,
  options: OpaintReadOptions,
): Promise<FileDocument> {
  const archive = openArchive(bytes);
  const warnings: string[] = [];
  const read = new Set<string>();
  let dirty = false;

  await checkMimetype(archive, warnings, read);

  const manifest = parseManifest(
    await readRequired(archive, DOCUMENT_JSON, DOCUMENT_JSON_MAX_BYTES),
  );
  read.add(DOCUMENT_JSON);
  const formatVersion = positiveInteger(manifest.formatVersion, "formatVersion");
  const minReaderVersion = positiveInteger(manifest.minReaderVersion, "minReaderVersion");
  if (minReaderVersion > OPAINT_READER_VERSION) {
    throw new OpaintFormatError("newerReader", "The file needs a newer reader.");
  }
  if (formatVersion > OPAINT_READER_VERSION) warnings.push(OPAINT_WARNINGS.newerVersion);

  const width = integerField(manifest.width, "width");
  const height = integerField(manifest.height, "height");
  if (!isValidImageSize(width, height)) throw corrupt(`Invalid size ${width}x${height}.`);
  const layerRecords = parseLayers(manifest.layers);
  if (archive.entries.length > layerRecords.length + EXTRA_ENTRIES) {
    throw corrupt("The archive has too many entries.");
  }
  const resolution = parseResolution(manifest.resolution, warnings);
  const selection = parseSelection(manifest.selection, warnings);
  const activeLayer = parseActiveLayer(manifest.activeLayer, layerRecords.length);
  const metadataPaths = parseMetadataPaths(manifest.metadata);
  const profilePath = parseProfilePath(manifest.colorProfile);

  const layerBytes = layerRecords.length * width * height * RGBA_CHANNELS;
  if (layerBytes > options.memoryBudgetBytes) {
    throw new OutOfMemoryError(layerBytes, options.memoryBudgetBytes, "newImage");
  }

  const surfaces: Surface[] = [];
  const damaged: boolean[] = [];
  for (const record of layerRecords) {
    const entry = archive.find(record.src);
    const pixels =
      entry === undefined ? undefined : await readLayerPixels(archive, entry, width, height);
    if (entry !== undefined) read.add(record.src);
    if (pixels === undefined) {
      surfaces.push(blankSurface(width, height));
      damaged.push(true);
    } else {
      surfaces.push(pixels);
      damaged.push(false);
    }
  }
  if (damaged.some(Boolean)) dirty = true;

  const profile =
    profilePath === undefined
      ? undefined
      : await readOptional(archive, profilePath, PROFILE_MAX_BYTES, warnings);
  if (profilePath !== undefined) read.add(profilePath);
  if (profile !== undefined) {
    const converted = await applyProfile(surfaces, damaged, profile, warnings);
    if (converted) dirty = true;
  }

  const exif =
    metadataPaths.exif === undefined
      ? undefined
      : await readOptional(archive, metadataPaths.exif, METADATA_MAX_BYTES, warnings);
  if (metadataPaths.exif !== undefined) read.add(metadataPaths.exif);
  const xmp: string[] = [];
  for (const path of metadataPaths.xmp) {
    const packet = await readOptional(archive, path, METADATA_MAX_BYTES, warnings);
    read.add(path);
    if (packet !== undefined) xmp.push(decodeText(packet, warnings));
  }
  const iptc =
    metadataPaths.iptc === undefined
      ? undefined
      : await readOptional(archive, metadataPaths.iptc, METADATA_MAX_BYTES, warnings);
  if (metadataPaths.iptc !== undefined) read.add(metadataPaths.iptc);
  const user = await readUser(archive, metadataPaths.custom, warnings, read);

  const preserved: Record<string, Uint8Array> = {};
  for (const entry of archive.entries) {
    if (read.has(entry.path)) continue;
    read.add(entry.path);
    const data = await readOptional(archive, entry.path, METADATA_MAX_BYTES, warnings);
    if (data !== undefined && entry.path !== THUMBNAIL) preserved[entry.path] = data;
  }

  const layers: BitmapLayer[] = layerRecords.map((record, index) => ({
    name: record.name,
    visible: record.visible,
    opacity: record.opacity,
    blendMode: record.blendMode,
    surface: surfaces[index] ?? blankSurface(width, height),
    isBackground: record.isBackground,
    ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
    ...(record.rawBlendMode === undefined ? {} : { rawBlendMode: record.rawBlendMode }),
    extras: record.extras,
    ...(damaged[index] === true ? { damaged: true } : {}),
  }));

  return {
    width,
    height,
    resolution,
    colorProfile: "srgb",
    metadata: {
      ...(exif === undefined ? {} : { exif }),
      xmp,
      ...(iptc === undefined ? {} : { iptc }),
      user,
    },
    layers,
    activeLayer,
    ...(selection === undefined ? {} : { selection }),
    extras: formatExtras(manifest, preserved),
    warnings,
    dirty,
  };
}

/**
 * Writes a file model as a `.opaint` package (FMT-NAT-02..07). Layers are PNGs of the canvas size in
 * straight RGBA. The writer reports progress per layer and returns the bytes only after every entry is
 * encoded, so a canceled save writes nothing (FMT-SAVE-03).
 */
export async function writeOpaint(
  file: FileDocument,
  progress: (fraction: number) => void = () => undefined,
): Promise<Uint8Array> {
  const extras = file.extras ?? {};
  const layerPaths = file.layers.map((_, index) => layerPath(index));
  const written = new Set<string>([MIMETYPE, DOCUMENT_JSON, THUMBNAIL, ...layerPaths]);
  const metadata = metadataEntries(file);
  for (const entry of metadata.entries) written.add(entry.path);

  const unknown: ZipInput[] = [];
  for (const [path, data] of Object.entries(extras.entries ?? {})) {
    if (written.has(path) || !isSafeEntryPath(path)) continue;
    unknown.push({ path, data, deflate: true });
  }

  const manifest = buildManifest(
    file,
    extras,
    layerPaths,
    metadata.paths,
    file.thumbnail !== undefined,
  );
  const entries: ZipInput[] = [
    { path: MIMETYPE, data: new TextEncoder().encode(OPAINT_MIME), deflate: false },
    {
      path: DOCUMENT_JSON,
      data: new TextEncoder().encode(JSON.stringify(manifest)),
      deflate: true,
    },
  ];
  if (file.thumbnail !== undefined) {
    const thumbnail = await encodeLayer(fitThumbnail(file.thumbnail));
    entries.push({ path: THUMBNAIL, data: thumbnail, deflate: false });
  }
  entries.push(...metadata.entries, ...unknown);
  for (const [index, layer] of file.layers.entries()) {
    progress(index / file.layers.length);
    const path = layerPaths[index];
    if (path === undefined) throw new RangeError("A layer has no path.");
    entries.push({ path, data: await encodeLayer(layer.surface), deflate: false });
  }
  progress(1);
  return writeZip(entries);
}

function openArchive(bytes: Uint8Array): ZipArchive {
  try {
    return ZipArchive.open(bytes);
  } catch (cause) {
    if (cause instanceof ZipError) throw corrupt("The file is not a readable archive.", cause);
    throw cause;
  }
}

async function checkMimetype(
  archive: ZipArchive,
  warnings: string[],
  read: Set<string>,
): Promise<void> {
  const entry = archive.find(MIMETYPE);
  if (entry === undefined) {
    warnings.push(OPAINT_WARNINGS.mimetype);
    return;
  }
  read.add(MIMETYPE);
  const content = await readRequired(archive, MIMETYPE, MIMETYPE_MAX_BYTES);
  const text = new TextDecoder().decode(content);
  if (text !== OPAINT_MIME) {
    throw new OpaintFormatError(
      "unrecognized",
      "The image type is not recognized, and cannot be opened.",
    );
  }
  if (archive.entries[0] !== entry || entry.method !== 0) warnings.push(OPAINT_WARNINGS.mimetype);
}

async function readRequired(
  archive: ZipArchive,
  path: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const entry = archive.find(path);
  if (entry === undefined) throw corrupt(`${path} is missing.`);
  try {
    return await archive.read(entry, maxBytes);
  } catch (cause) {
    throw corrupt(`${path} cannot be read.`, cause);
  }
}

/** An optional entry. A missing or damaged one is skipped with a warning (FMT-NAT-09). */
async function readOptional(
  archive: ZipArchive,
  path: string,
  maxBytes: number,
  warnings: string[],
): Promise<Uint8Array | undefined> {
  const entry = archive.find(path);
  try {
    if (entry === undefined) throw new ZipError(`${path} is missing.`);
    return await archive.read(entry, maxBytes);
  } catch {
    if (!warnings.includes(OPAINT_WARNINGS.entrySkipped))
      warnings.push(OPAINT_WARNINGS.entrySkipped);
    return undefined;
  }
}

function parseManifest(bytes: Uint8Array): JsonObject {
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    value = JSON.parse(text);
  } catch (cause) {
    throw corrupt("document.json is not valid UTF-8 JSON.", cause);
  }
  if (!isObject(value) || value.format !== "openpaint") {
    throw corrupt("document.json is not an OpenPaint manifest.");
  }
  return value;
}

function parseLayers(value: unknown): ManifestLayer[] {
  if (!Array.isArray(value) || value.length === 0) throw corrupt("The file has no layers.");
  return value.map((raw, index) => {
    if (!isObject(raw) || typeof raw.src !== "string" || !isSafeEntryPath(raw.src)) {
      throw corrupt(`Layer ${index} has no valid picture path.`);
    }
    const rawMode = raw.blendMode;
    const known =
      typeof rawMode === "number" && Number.isInteger(rawMode) && isLayerBlendMode(rawMode);
    const unknownMode = typeof rawMode === "number" && Number.isInteger(rawMode) && !known;
    return {
      name: typeof raw.name === "string" ? truncateLayerName(raw.name) : `Layer ${index + 1}`,
      visible: typeof raw.visible === "boolean" ? raw.visible : true,
      opacity: clampOpacity(raw.opacity),
      blendMode: known ? (rawMode as LayerBlendMode) : LayerBlendMode.normal,
      rawBlendMode: unknownMode ? (rawMode as number) : undefined,
      isBackground: raw.isBackground === true,
      src: raw.src,
      metadata: stringMap(raw.metadata),
      extras: unknownKeys(raw, LAYER_KEYS),
    };
  });
}

function clampOpacity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return MAX_OPACITY;
  return Math.min(MAX_OPACITY, Math.max(0, Math.round(value)));
}

function parseResolution(value: unknown, warnings: string[]): Resolution {
  if (value === undefined) return DEFAULT_RESOLUTION;
  const unit = isObject(value) ? value.unit : undefined;
  if (
    !isObject(value) ||
    typeof value.x !== "number" ||
    typeof value.y !== "number" ||
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y) ||
    !RESOLUTION_UNITS.includes(unit as (typeof RESOLUTION_UNITS)[number])
  ) {
    warnings.push(OPAINT_WARNINGS.resolution);
    return DEFAULT_RESOLUTION;
  }
  const x = clampResolution(value.x);
  const y = clampResolution(value.y);
  if (x !== value.x || y !== value.y) warnings.push(OPAINT_WARNINGS.resolution);
  const resolution = { x, y, unit: unit as Resolution["unit"] };
  return isValidResolution(resolution) ? resolution : DEFAULT_RESOLUTION;
}

function clampResolution(value: number): number {
  return Math.min(MAX_RESOLUTION, Math.max(MIN_RESOLUTION, value));
}

function parseSelection(value: unknown, warnings: string[]): FileSelection | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isObject(value) || !Array.isArray(value.polygons) || !value.polygons.every(isPolygon)) {
    warnings.push(OPAINT_WARNINGS.selection);
    return undefined;
  }
  if (value.polygons.length === 0) return undefined;
  const quality: SelectionQuality = value.quality === "aliased" ? "aliased" : "antialiased";
  const polygons: SelectionPolygon[] = value.polygons.map((polygon) => [...polygon]);
  return { polygons, quality };
}

function isPolygon(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length >= 6 &&
    value.length % 2 === 0 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

function parseActiveLayer(value: unknown, layerCount: number): number {
  const top = layerCount - 1;
  if (!Number.isInteger(value)) return top;
  const index = value as number;
  return index >= 0 && index < layerCount ? index : top;
}

interface MetadataPaths {
  readonly exif?: string;
  readonly xmp: readonly string[];
  readonly iptc?: string;
  readonly custom?: string;
}

function parseMetadataPaths(value: unknown): MetadataPaths {
  if (!isObject(value)) return { xmp: [] };
  const paths = {
    exif: pathField(value.exif),
    xmp: Array.isArray(value.xmp)
      ? value.xmp.filter((path): path is string => typeof path === "string").map(safePath)
      : [],
    iptc: pathField(value.iptc),
    custom: pathField(value.custom),
  };
  return paths;
}

function parseProfilePath(value: unknown): string | undefined {
  return isObject(value) ? pathField(value.path) : undefined;
}

function pathField(value: unknown): string | undefined {
  return typeof value === "string" ? safePath(value) : undefined;
}

function safePath(path: string): string {
  if (!isSafeEntryPath(path)) throw corrupt(`Unsafe entry path ${path}.`);
  return path;
}

/** The document-level unknown keys, the resolution's, the metadata's and the unknown entries. */
function formatExtras(manifest: JsonObject, entries: Record<string, Uint8Array>): FormatExtras {
  const document = unknownKeys(manifest, DOCUMENT_KEYS);
  const resolution = isObject(manifest.resolution)
    ? unknownKeys(manifest.resolution, RESOLUTION_KEYS)
    : {};
  const metadata = isObject(manifest.metadata) ? unknownKeys(manifest.metadata, METADATA_KEYS) : {};
  return {
    ...(Object.keys(document).length > 0 ? { document } : {}),
    ...(Object.keys(resolution).length > 0 ? { resolution } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(Object.keys(entries).length > 0 ? { entries } : {}),
  };
}

function unknownKeys(object: JsonObject, known: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    if (!known.has(key)) out[key] = value;
  }
  return out;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

async function readLayerPixels(
  archive: ZipArchive,
  entry: ZipEntry,
  width: number,
  height: number,
): Promise<Surface | undefined> {
  try {
    const png = await archive.read(entry, width * height * 8 + height + PNG_OVERHEAD_BYTES);
    const size = pngSize(png);
    if (size === undefined || size.width !== width || size.height !== height) return undefined;
    const decoded = decodePngPixels(png);
    if (
      decoded.width !== width ||
      decoded.height !== height ||
      decoded.pixels.byteLength !== width * height * RGBA_CHANNELS
    ) {
      return undefined;
    }
    return new Surface(width, height, new Uint8ClampedArray(decoded.pixels));
  } catch {
    return undefined;
  }
}

/** Width and height from a PNG's IHDR, read before any pixel is decoded (FMT-NAT-10). */
function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.byteLength < PNG_IHDR_END) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(PNG_SIGNATURE_BYTES + 4) !== 0x49484452) return undefined;
  return {
    width: view.getUint32(PNG_SIGNATURE_BYTES + 8),
    height: view.getUint32(PNG_SIGNATURE_BYTES + 12),
  };
}

function blankSurface(width: number, height: number): Surface {
  return new Surface(width, height, new Uint8ClampedArray(width * height * RGBA_CHANNELS));
}

/**
 * Converts the layers from an embedded profile (FMT-NAT-07). The conversion is all or nothing: a
 * profile that cannot be used leaves every layer as it was and raises a warning.
 */
async function applyProfile(
  surfaces: Surface[],
  damaged: readonly boolean[],
  profile: Uint8Array,
  warnings: string[],
): Promise<boolean> {
  let converted: Surface[];
  try {
    const space = await profileSpace(profile);
    if (space !== "rgb" && space !== "gray") {
      warnings.push(OPAINT_WARNINGS.profileIgnored);
      return false;
    }
    converted = [];
    for (const [index, surface] of surfaces.entries()) {
      if (damaged[index] === true) {
        converted.push(surface);
        continue;
      }
      const pixels = await convertRgbaToSrgb(straightRgba(surface), 8, profile, space);
      converted.push(new Surface(surface.width, surface.height, new Uint8ClampedArray(pixels)));
    }
  } catch (cause) {
    if (cause instanceof ProfileError) {
      warnings.push(OPAINT_WARNINGS.profileIgnored);
      return false;
    }
    throw cause;
  }
  for (const [index, surface] of converted.entries()) surfaces[index] = surface;
  warnings.push(OPAINT_WARNINGS.profileConverted);
  return true;
}

async function readUser(
  archive: ZipArchive,
  path: string | undefined,
  warnings: string[],
  read: Set<string>,
): Promise<Record<string, string>> {
  if (path === undefined) return {};
  read.add(path);
  const bytes = await readOptional(archive, path, METADATA_MAX_BYTES, warnings);
  if (bytes === undefined) return {};
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return stringMap(value) ?? {};
  } catch {
    if (!warnings.includes(OPAINT_WARNINGS.entrySkipped))
      warnings.push(OPAINT_WARNINGS.entrySkipped);
    return {};
  }
}

function decodeText(bytes: Uint8Array, warnings: string[]): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    warnings.push(OPAINT_WARNINGS.entrySkipped);
    return "";
  }
}

interface MetadataOutput {
  readonly entries: ZipInput[];
  readonly paths: { exif?: string; xmp: string[]; iptc?: string; custom?: string };
}

function metadataEntries(file: FileDocument): MetadataOutput {
  const entries: ZipInput[] = [];
  const paths: { exif?: string; xmp: string[]; iptc?: string; custom?: string } = { xmp: [] };
  const encoder = new TextEncoder();
  if (file.metadata.exif !== undefined) {
    entries.push({ path: EXIF, data: file.metadata.exif, deflate: true });
    paths.exif = EXIF;
  }
  for (const [index, packet] of file.metadata.xmp.entries()) {
    const path = index === 0 ? "metadata/xmp.xml" : `metadata/xmp-${index}.xml`;
    entries.push({ path, data: encoder.encode(packet), deflate: true });
    paths.xmp.push(path);
  }
  if (file.metadata.iptc !== undefined) {
    entries.push({ path: IPTC, data: file.metadata.iptc, deflate: true });
    paths.iptc = IPTC;
  }
  if (Object.keys(file.metadata.user).length > 0) {
    entries.push({
      path: CUSTOM,
      data: encoder.encode(JSON.stringify(file.metadata.user)),
      deflate: true,
    });
    paths.custom = CUSTOM;
  }
  return { entries, paths };
}

function buildManifest(
  file: FileDocument,
  extras: FormatExtras,
  layerPaths: readonly string[],
  metadataPaths: MetadataOutput["paths"],
  hasThumbnail: boolean,
): JsonObject {
  const metadata: JsonObject = {
    ...(extras.metadata ?? {}),
    ...(metadataPaths.exif === undefined ? {} : { exif: metadataPaths.exif }),
    ...(metadataPaths.xmp.length === 0 ? {} : { xmp: metadataPaths.xmp }),
    ...(metadataPaths.iptc === undefined ? {} : { iptc: metadataPaths.iptc }),
    ...(metadataPaths.custom === undefined ? {} : { custom: metadataPaths.custom }),
  };
  const selection =
    file.selection === undefined || file.selection.polygons.length === 0
      ? undefined
      : {
          polygons: file.selection.polygons.map((polygon) => [...polygon]),
          quality: file.selection.quality,
        };
  const layers = file.layers.map((layer, index) => {
    const layerMetadata = layer.metadata ?? {};
    return {
      ...(layer.extras ?? {}),
      name: truncateLayerName(layer.name),
      visible: layer.visible,
      opacity: Math.min(MAX_OPACITY, Math.max(0, Math.round(layer.opacity))),
      blendMode: layer.rawBlendMode ?? layer.blendMode,
      isBackground: layer.isBackground === true,
      src: layerPaths[index],
      ...(Object.keys(layerMetadata).length === 0 ? {} : { metadata: layerMetadata }),
    };
  });
  const activeLayer = Math.min(
    file.layers.length - 1,
    Math.max(0, file.activeLayer ?? file.layers.length - 1),
  );
  return {
    ...(extras.document ?? {}),
    format: "openpaint",
    formatVersion: OPAINT_FORMAT_VERSION,
    minReaderVersion: OPAINT_READER_VERSION,
    generator: GENERATOR,
    width: file.width,
    height: file.height,
    resolution: {
      ...(extras.resolution ?? {}),
      x: file.resolution.x,
      y: file.resolution.y,
      unit: file.resolution.unit,
    },
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
    ...(hasThumbnail ? { thumbnail: THUMBNAIL } : {}),
    layers,
    activeLayer,
    ...(selection === undefined ? {} : { selection }),
  };
}

function fitThumbnail(surface: Surface): Surface {
  const scale = Math.min(
    1,
    THUMBNAIL_MAX_SIZE / surface.width,
    THUMBNAIL_MAX_SIZE / surface.height,
  );
  if (scale === 1) return surface;
  return resampleSurface(
    surface,
    Math.max(1, Math.floor(surface.width * scale)),
    Math.max(1, Math.floor(surface.height * scale)),
    { filter: "lanczos3", linearLight: false },
  );
}

async function encodeLayer(surface: Surface): Promise<Uint8Array> {
  return encodePngAsync(
    { width: surface.width, height: surface.height, data: straightRgba(surface) },
    deflateZlib,
  );
}

function layerPath(index: number): string {
  return `layers/${index}.png`;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw corrupt(`${name} must be a positive integer.`);
  }
  return value as number;
}

function integerField(value: unknown, name: string): number {
  if (!Number.isInteger(value)) throw corrupt(`${name} must be an integer.`);
  return value as number;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function corrupt(message: string, cause?: unknown): OpaintFormatError {
  return new OpaintFormatError("corrupt", message, cause === undefined ? undefined : { cause });
}
