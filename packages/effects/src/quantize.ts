import { quantize_palette } from "@openpaint/cpu";
import type { Surface } from "@openpaint/document";
import { type EffectDescriptor, EXTENSION_API_MAJOR } from "@openpaint/extension-api";
import {
  definePropertySchema,
  numberValue,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
} from "@openpaint/properties";
import { distortedSurface, surfaceBytes } from "./distortion";
import type { EffectBinding } from "./framework/binding";

export const QUANTIZE_ID = "quantize";

/** The palette algorithms of Quantize, by their ids in `quantize_palette`. */
const ALGORITHM_IDS = { medianCut: 0, octree: 1 } as const;

/** Parameters of Quantize (FX-COLOR-QUANTIZE-01). */
export interface QuantizeParams {
  readonly algorithm: keyof typeof ALGORITHM_IDS;
  /** Palette entries for the opaque colors, 2 to 256. */
  readonly colors: number;
  /** Dithering level, 0 (none) to 8 (strongest). */
  readonly dithering: number;
  /** Pixels with an alpha below this become fully transparent. 0 turns transparency off. */
  readonly transparencyThreshold: number;
}

/**
 * The Quantize schema (FX-COLOR-QUANTIZE-01). The labels and ranges match the PNG save options, so
 * the same words mean the same thing in both places.
 */
export function quantizeSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "choice",
        key: "algorithm",
        label: "property.noCaption",
        defaultValue: "octree",
        options: [
          { value: "medianCut", label: "fileOption.quantization.medianCut" },
          { value: "octree", label: "fileOption.quantization.octree" },
        ],
        control: { description: "property.algorithm" },
      },
      {
        kind: "int32",
        key: "colors",
        label: "property.colors",
        defaultValue: 256,
        min: 2,
        max: 256,
      },
      {
        kind: "int32",
        key: "dithering",
        label: "fileOption.dithering",
        defaultValue: 7,
        min: 0,
        max: 8,
      },
      {
        kind: "int32",
        key: "transparencyThreshold",
        label: "fileOption.transparencyThreshold",
        defaultValue: 128,
        min: 0,
        max: 255,
        control: { description: "fileOption.transparencyThreshold.description" },
      },
    ],
  });
}

export function quantizeDescriptor(): EffectDescriptor {
  return {
    id: QUANTIZE_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.quantize",
    icon: "icon.quantize",
    category: "effect",
    submenu: "color",
    configurable: true,
    kind: "cpuRegion",
    schema: quantizeSchema(),
    options: { singleThreaded: true, uninitializedOutput: true, schedule: "none" },
  };
}

/** Reads Quantize's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function quantizeParams(values: PropertyValues): QuantizeParams {
  const resolved = resolveValues(quantizeSchema(), values);
  return {
    algorithm: resolved.algorithm === "medianCut" ? "medianCut" : "octree",
    colors: numberValue(resolved, "colors"),
    dithering: numberValue(resolved, "dithering"),
    transparencyThreshold: numberValue(resolved, "transparencyThreshold"),
  };
}

/**
 * The Rust reference of Quantize (FX-COLOR-QUANTIZE-01). The palette is built from the selected,
 * not fully transparent pixels by the 8-bit palette quantizer (`quantize_palette`, FMT-QNT-01), and
 * every such pixel takes its palette color with dithering. Transparency applies when the threshold
 * is above 0 and the region has a non-opaque pixel: a pixel with a lower alpha becomes fully
 * transparent and stays out of the palette. Kept pixels keep their alpha. Pixels outside the
 * selection keep their input, and `coverage` (0-255) is that selection, with undefined meaning all.
 */
export function quantizeCpu(
  input: Surface,
  params: QuantizeParams,
  coverage?: ArrayLike<number>,
): Surface {
  const source = surfaceBytes(input);
  const count = input.width * input.height;
  const out = new Uint8Array(source);
  if (count === 0) return distortedSurface(input, out);

  const transparency = params.transparencyThreshold > 0 && hasNonOpaque(source);
  const selected = (pixel: number): boolean => coverage === undefined || (coverage[pixel] ?? 0) > 0;

  // Alpha 255 marks a pixel that takes part in the palette, and 0 marks one that stays out of it.
  const prepared = new Uint8Array(source.length);
  for (let pixel = 0; pixel < count; pixel++) {
    if (!selected(pixel)) continue;
    const at = pixel * 4;
    prepared.set(source.subarray(at, at + 3), at);
    const alpha = source[at + 3] ?? 0;
    prepared[at + 3] = transparency && alpha < params.transparencyThreshold ? 0 : 255;
  }

  const { palette, indices } = quantizePalette(prepared, input.width, input.height, params);
  for (let pixel = 0; pixel < count; pixel++) {
    if (!selected(pixel)) continue;
    const at = pixel * 4;
    if (prepared[at + 3] === 0) {
      out.fill(0, at, at + 4);
      continue;
    }
    const color = (indices[pixel] ?? 0) * 3;
    out[at] = palette[color] ?? 0;
    out[at + 1] = palette[color + 1] ?? 0;
    out[at + 2] = palette[color + 2] ?? 0;
  }
  return distortedSurface(input, out);
}

function hasNonOpaque(bytes: Uint8Array): boolean {
  for (let at = 3; at < bytes.length; at += 4) {
    if ((bytes[at] ?? 0) < 255) return true;
  }
  return false;
}

/**
 * Runs the WASM palette quantizer on prepared pixels. Alpha 0 marks the pixels that stay out of the
 * palette, so `transparent_entry` is always set.
 */
function quantizePalette(
  prepared: Uint8Array,
  width: number,
  height: number,
  params: QuantizeParams,
): { palette: Uint8Array; indices: Uint8Array } {
  const result = quantize_palette(
    prepared,
    width,
    height,
    params.colors,
    true,
    ALGORITHM_IDS[params.algorithm],
    params.dithering,
  );
  try {
    return { palette: result.palette, indices: result.indices };
  } finally {
    result.free();
  }
}

/** The host binding of Quantize: its descriptor, parameter reader and CPU reference. */
export function quantizeBinding(): EffectBinding<QuantizeParams> {
  return {
    descriptor: quantizeDescriptor(),
    params: quantizeParams,
    cpu: quantizeCpu,
  };
}
