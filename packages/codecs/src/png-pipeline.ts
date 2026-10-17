import type { Surface } from "@openpaint/document";
import type { PngDepth, PngImage } from "./png-encoder";

/** The "Quantization algorithm" choices (FMT-OPT-PNG-01). */
export type PaletteAlgorithm = "medianCut" | "octree";

/**
 * The palette hook (FMT-QNT-01 step 5). It runs only when the colors do not fit the palette exactly.
 * It gets the prepared straight-alpha RGBA pixels, where transparent pixels have alpha 0 (only when
 * `transparentEntry` is set), and the number of palette entries it may use. It returns RGB triples and
 * one index per pixel. Indices of transparent pixels are ignored. The PNG save passes the WASM quantizer (`quantize.ts`).
 * Without a quantizer, a lossy palette fails with a `PngPaletteError`.
 */
export type PaletteQuantizer = (request: {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly capacity: number;
  readonly transparentEntry: boolean;
  readonly algorithm: PaletteAlgorithm;
  readonly dithering: number;
}) => { readonly palette: Uint8Array; readonly indices: Uint8Array };

/** The depth the user chose; 0 means Auto-detect (FMT-QNT-02). */
export type BitDepthChoice = 0 | PngDepth;

/**
 * The outputs a format can write (FMT-QNT-02). PNG writes every depth and 8-bit with a 1-bit alpha
 * palette. BMP has no 2-bit depth and no alpha palette, and its indexed and 24-bit images are
 * composited over white. TGA writes 24 and 32 bits only.
 */
export interface FormatTargets {
  readonly depths: readonly PngDepth[];
  readonly alphaPalette: boolean;
}

export const PNG_TARGETS: FormatTargets = { depths: [32, 24, 8, 4, 2, 1], alphaPalette: true };

export interface PngPipelineOptions {
  readonly bitDepth: BitDepthChoice;
  readonly quantization: PaletteAlgorithm;
  readonly dithering: number;
  readonly transparencyThreshold: number;
  /** The outputs the format writes. Defaults to PNG's. */
  readonly targets?: FormatTargets;
}

export interface PngPipelineHooks {
  /** Encodes a candidate image, for the trial encodes of Auto-detect. */
  readonly encode: (image: PngImage) => Uint8Array;
  /** Progress over the whole save, 0 to 1 (FMT-QNT-02 "Progress"). */
  readonly progress: (fraction: number) => void;
  readonly quantize?: PaletteQuantizer;
}

/** Raised when a lossy palette is needed and no quantizer is available. */
export class PngPaletteError extends Error {
  override readonly name = "PngPaletteError";
  constructor(readonly bits: number) {
    super(`An image with more colors than a ${bits}-bit palette holds needs a palette quantizer.`);
  }
}

/** A target the image can be written as: a depth, or 8-bit with a 1-bit alpha palette. */
type Target = PngDepth | "8a";

interface Analysis {
  readonly area: number;
  /** Every pixel is opaque. */
  readonly allOpaque: boolean;
  /** Every pixel is fully transparent or fully opaque. */
  readonly binaryAlpha: boolean;
  /** Distinct colors of the opaque pixels, counted up to 257. */
  readonly colors: number;
}

/** The largest count that the lossless rules compare against (256 colors, plus one). */
const COUNT_CAP = 257;
/** The trial encodes of FMT-QNT-02 apply to images up to this area. */
const TRIAL_AREA = 65536;
/** The Auto-detect order for lossless targets, lowest depth first (FMT-QNT-02 step 3). */
const PRIORITY: readonly Target[] = [1, 2, 4, 8, "8a", 24, 32];

/**
 * Turns a surface into the image to encode (FMT-QNT-01 steps 3 to 5): it chooses the depth, prepares
 * the pixels for it, and maps them to a palette when the depth is indexed.
 */
export function choosePngImage(
  surface: Surface,
  options: PngPipelineOptions,
  hooks: PngPipelineHooks,
): PngImage {
  const data = new Uint8Array(
    surface.data.buffer,
    surface.data.byteOffset,
    surface.data.byteLength,
  );
  const analysis = analyze(data, surface.width, surface.height);
  hooks.progress(1 / 3);
  const targets = options.targets ?? PNG_TARGETS;
  const target =
    options.bitDepth === 0
      ? autoTarget(surface, data, analysis, options, targets, hooks)
      : explicitTarget(options.bitDepth, analysis, targets);
  const image = imageFor(surface, data, target, options, hooks);
  hooks.progress(2 / 3);
  return image;
}

/** FMT-QNT-02 "Auto-detect": the lossless depths, then the trial and priority rules. */
function autoTarget(
  surface: Surface,
  data: Uint8Array,
  analysis: Analysis,
  options: PngPipelineOptions,
  targets: FormatTargets,
  hooks: PngPipelineHooks,
): Target {
  const lossless = losslessTargets(analysis, targets);
  if (lossless.length === 1) return lossless[0] ?? 32;
  const trial = trialPair(analysis, targets);
  if (trial !== undefined && analysis.area <= TRIAL_AREA) {
    const [first, second] = trial;
    const firstBytes = hooks.encode(imageFor(surface, data, first, options, hooks)).length;
    hooks.progress(1 / 2);
    const secondBytes = hooks.encode(imageFor(surface, data, second, options, hooks)).length;
    hooks.progress(2 / 3);
    return secondBytes < firstBytes ? second : first;
  }
  return PRIORITY.find((target) => lossless.includes(target)) ?? 32;
}

/** The two candidates the trial encodes compare for this image, when a trial applies. */
function trialPair(
  analysis: Analysis,
  targets: FormatTargets,
): readonly [Target, Target] | undefined {
  const has = (depth: PngDepth) => targets.depths.includes(depth);
  if (analysis.allOpaque && analysis.colors <= 16 && has(4) && has(24)) return [4, 24];
  if (analysis.allOpaque && analysis.colors <= 256 && has(8) && has(24)) return [8, 24];
  if (analysis.binaryAlpha && analysis.colors <= 255 && targets.alphaPalette) return ["8a", 32];
  return undefined;
}

/** The lossless targets of FMT-QNT-02, in the order the table lists them, with 32-bit always last. */
function losslessTargets(analysis: Analysis, targets: FormatTargets): Target[] {
  const { colors } = analysis;
  const has = (depth: PngDepth) => targets.depths.includes(depth);
  const lossless: Target[] = [];
  if (analysis.allOpaque) {
    if (has(1) && colors <= 2) lossless.push(1);
    if (has(2) && colors <= 4) lossless.push(2);
    if (has(4) && colors <= 16) lossless.push(4);
    if (has(8) && colors <= 256) lossless.push(8);
    if (has(24)) lossless.push(24);
  } else if (analysis.binaryAlpha && colors <= 255 && targets.alphaPalette) {
    lossless.push("8a");
  }
  if (has(32)) lossless.push(32);
  return lossless;
}

/**
 * The target of an explicit bit depth. 8-bit becomes 8-bit with 1-bit alpha when a pixel is not
 * opaque, on a format that has that palette.
 */
function explicitTarget(bitDepth: PngDepth, analysis: Analysis, targets: FormatTargets): Target {
  if (bitDepth === 8) return analysis.allOpaque || !targets.alphaPalette ? 8 : "8a";
  return bitDepth;
}

function analyze(data: Uint8Array, width: number, height: number): Analysis {
  let allOpaque = true;
  let binaryAlpha = true;
  const colors = new Set<number>();
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] ?? 0;
    if (alpha !== 255) {
      allOpaque = false;
      if (alpha !== 0) binaryAlpha = false;
    } else if (colors.size < COUNT_CAP) {
      colors.add(((data[i] ?? 0) << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0));
    }
  }
  return { area: width * height, allOpaque, binaryAlpha, colors: colors.size };
}

/** The prepared image for one target (FMT-QNT-03), with a palette for the indexed targets. */
function imageFor(
  surface: Surface,
  data: Uint8Array,
  target: Target,
  options: PngPipelineOptions,
  hooks: PngPipelineHooks,
): PngImage {
  const { width, height } = surface;
  if (target === 32) {
    return {
      width,
      height,
      depth: 32,
      pixels: data,
      palette: new Uint8Array(0),
      alpha: new Uint8Array(0),
    };
  }
  const threshold = target === "8a" ? options.transparencyThreshold : 0;
  const rgba = prepare(data, target === "8a", threshold);
  if (target === 24) {
    return {
      width,
      height,
      depth: 24,
      pixels: rgbOf(rgba),
      palette: new Uint8Array(0),
      alpha: new Uint8Array(0),
    };
  }
  const bits = target === "8a" ? 8 : target;
  return indexed(rgba, width, height, bits, target === "8a", options, hooks);
}

/**
 * Prepares straight RGBA for a target without alpha: every pixel is composited over white (FMT-QNT-03).
 * With the 1-bit alpha target, a pixel below the threshold becomes transparent, and the others are
 * composited over white.
 */
function prepare(data: Uint8Array, withAlpha: boolean, threshold: number): Uint8Array {
  const out = new Uint8Array(new ArrayBuffer(data.length));
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] ?? 0;
    if (withAlpha && alpha < threshold) continue;
    for (let channel = 0; channel < 3; channel++) {
      out[i + channel] = overWhite(data[i + channel] ?? 0, alpha);
    }
    out[i + 3] = 255;
  }
  return out;
}

/** A color composited over white, rounding half up: `(c a + 255 (255 - a)) / 255`. */
function overWhite(color: number, alpha: number): number {
  return Math.floor((color * alpha + 255 * (255 - alpha) + 127) / 255);
}

function rgbOf(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(new ArrayBuffer((rgba.length / 4) * 3));
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    out[j] = rgba[i] ?? 0;
    out[j + 1] = rgba[i + 1] ?? 0;
    out[j + 2] = rgba[i + 2] ?? 0;
  }
  return out;
}

/**
 * Maps prepared pixels to an indexed palette. The exact colors are used when they fit (FMT-QNT-01
 * step 5). Otherwise the palette hook builds one, and without a hook the save fails.
 */
function indexed(
  rgba: Uint8Array,
  width: number,
  height: number,
  bits: number,
  transparentEntry: boolean,
  options: PngPipelineOptions,
  hooks: PngPipelineHooks,
): PngImage {
  const capacity = (1 << bits) - (transparentEntry ? 1 : 0);
  const count = width * height;
  const indices = new Uint8Array(new ArrayBuffer(count));
  const slots = new Map<number, number>();
  const colors: number[] = [];
  let fits = true;
  for (let pixel = 0; pixel < count && fits; pixel++) {
    const i = pixel * 4;
    if (transparentEntry && rgba[i + 3] === 0) continue;
    const key = ((rgba[i] ?? 0) << 16) | ((rgba[i + 1] ?? 0) << 8) | (rgba[i + 2] ?? 0);
    let slot = slots.get(key);
    if (slot === undefined) {
      if (colors.length >= capacity) {
        fits = false;
        break;
      }
      slot = colors.length;
      colors.push(key);
      slots.set(key, slot);
    }
    indices[pixel] = slot;
  }

  let palette: Uint8Array;
  if (fits) {
    palette = Uint8Array.from(colors.flatMap((key) => [key >> 16, (key >> 8) & 0xff, key & 0xff]));
  } else {
    if (hooks.quantize === undefined) throw new PngPaletteError(bits);
    const result = hooks.quantize({
      width,
      height,
      pixels: rgba,
      capacity,
      transparentEntry,
      algorithm: options.quantization,
      dithering: options.dithering,
    });
    palette = result.palette;
    indices.set(result.indices.subarray(0, count));
    if (palette.length / 3 > capacity) throw new PngPaletteError(bits);
  }

  const opaqueEntries = palette.length / 3;
  const transparentIndex = opaqueEntries;
  if (transparentEntry) {
    for (let pixel = 0; pixel < count; pixel++) {
      if (rgba[pixel * 4 + 3] === 0) indices[pixel] = transparentIndex;
    }
    palette = concatBytes(palette, new Uint8Array(3));
  }
  const alpha = transparentEntry
    ? concatBytes(new Uint8Array(opaqueEntries).fill(255), Uint8Array.of(0))
    : new Uint8Array(0);
  return {
    width,
    height,
    depth: bits as PngDepth,
    pixels: indices,
    palette,
    alpha,
  };
}

function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  const out = new Uint8Array(new ArrayBuffer(first.length + second.length));
  out.set(first, 0);
  out.set(second, first.length);
  return out;
}
