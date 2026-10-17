import {
  black_and_white_rgba8,
  invert_alpha_rgba8,
  invert_colors_rgba8,
  sepia_exponents,
  sepia_rgba8,
} from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { type EffectDescriptor, EXTENSION_API_MAJOR } from "@openpaint/extension-api";
import {
  definePropertySchema,
  numberValue,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
} from "@openpaint/properties";
import type { EffectBinding } from "./framework/binding";

/** The adjustments that this module builds, by registry id. */
export const ADJUSTMENT_IDS = ["invertColors", "invertAlpha", "blackAndWhite", "sepia"] as const;
export type AdjustmentId = (typeof ADJUSTMENT_IDS)[number];

/** Sepia's declared default Intensity (ADJ-SEPIA table). */
export const SEPIA_DEFAULT_INTENSITY = 50;

/** Entries in one Curves lookup table, sampled over input 0..1 (ADJ-CURVES-MATH-02). */
export const CURVE_LUT_SIZE = 1024;
/** Curves tables in a plan: luminosity, then red, green and blue (ADJ-CURVES-MATH-03, -04). */
export const CURVE_TABLES = 4;

/** Parameters of Sepia (ADJ-SEPIA). The other adjustments take none. */
export interface SepiaParams {
  /** Intensity 0-100 (ADJ-SEPIA). */
  readonly intensity: number;
}

/** Parameters of an adjustment that has none. */
export type NoParams = Record<string, never>;

/** The op code the WGSL twin switches on (`ADJUSTMENTS_WGSL`). */
export const ADJUSTMENT_OPS: Readonly<Record<AdjustmentId, number>> = {
  invertColors: 0,
  invertAlpha: 1,
  blackAndWhite: 2,
  sepia: 3,
};

/**
 * A built-in adjustment's schema, with the header rule turned off next to every heading (ADJ-COMMON-04,
 * FX-FW-UI-02). Built-in effects do the same.
 */
export function adjustmentSchema(schema: PropertySchema): PropertySchema {
  return definePropertySchema({
    ...schema,
    properties: schema.properties.map((property) => ({
      ...property,
      control: { ...property.control, showHeaderLine: false },
    })),
  });
}

export function sepiaSchema(): PropertySchema {
  return adjustmentSchema({
    properties: [
      {
        kind: "int32",
        key: "intensity",
        label: "property.intensity",
        defaultValue: SEPIA_DEFAULT_INTENSITY,
        min: 0,
        max: 100,
      },
    ],
  });
}

/** The descriptor shared by every adjustment: category Adjustment, GPU image kind, straight alpha. */
export function adjustmentDescriptor(
  id: string,
  label: EffectDescriptor["label"],
  icon: string,
  configurable: boolean,
  schema: PropertySchema,
): EffectDescriptor {
  return {
    id,
    apiVersion: EXTENSION_API_MAJOR,
    label,
    icon,
    category: "adjustment",
    configurable,
    kind: "gpuImage",
    schema,
    options: { gpu: { workingSpace: "document", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

export function invertColorsDescriptor(): EffectDescriptor {
  return adjustmentDescriptor(
    "invertColors",
    "effect.invertColors",
    "icon.invertColors",
    false,
    definePropertySchema({ properties: [] }),
  );
}

export function invertAlphaDescriptor(): EffectDescriptor {
  return adjustmentDescriptor(
    "invertAlpha",
    "effect.invertAlpha",
    "icon.invertAlpha",
    false,
    definePropertySchema({ properties: [] }),
  );
}

export function blackAndWhiteDescriptor(): EffectDescriptor {
  return adjustmentDescriptor(
    "blackAndWhite",
    "effect.blackAndWhite",
    "icon.blackAndWhite",
    false,
    definePropertySchema({ properties: [] }),
  );
}

export function sepiaDescriptor(): EffectDescriptor {
  return adjustmentDescriptor("sepia", "effect.sepia", "icon.sepia", true, sepiaSchema());
}

/** Reads Sepia's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function sepiaParams(values: PropertyValues): SepiaParams {
  return { intensity: numberValue(resolveValues(sepiaSchema(), values), "intensity") };
}

/** The Rust reference of Invert Colors. The input is not modified. */
export function invertColorsCpu(input: Surface): Surface {
  return rgbaSurface(input, invert_colors_rgba8(bytesOf(input)));
}

/** The Rust reference of Invert Alpha. The input is not modified. */
export function invertAlphaCpu(input: Surface): Surface {
  return rgbaSurface(input, invert_alpha_rgba8(bytesOf(input)));
}

/** The Rust reference of Black and White. The input is not modified. */
export function blackAndWhiteCpu(input: Surface): Surface {
  return rgbaSurface(input, black_and_white_rgba8(bytesOf(input)));
}

/** The Rust reference of Sepia. The input is not modified. */
export function sepiaCpu(input: Surface, params: SepiaParams): Surface {
  return rgbaSurface(input, sepia_rgba8(bytesOf(input), params.intensity));
}

/** The CPU reference of any built-in adjustment in this module. */
export function adjustmentCpu(id: AdjustmentId, input: Surface, intensity: number): Surface {
  switch (id) {
    case "invertColors":
      return invertColorsCpu(input);
    case "invertAlpha":
      return invertAlphaCpu(input);
    case "blackAndWhite":
      return blackAndWhiteCpu(input);
    case "sepia":
      return sepiaCpu(input, { intensity });
  }
}

/** The host binding of Invert Colors: its descriptor and CPU reference. */
export function invertColorsBinding(): EffectBinding<NoParams> {
  return nonConfigurable(invertColorsDescriptor(), invertColorsCpu);
}

/** The host binding of Invert Alpha: its descriptor and CPU reference. */
export function invertAlphaBinding(): EffectBinding<NoParams> {
  return nonConfigurable(invertAlphaDescriptor(), invertAlphaCpu);
}

/** The host binding of Black and White: its descriptor and CPU reference. */
export function blackAndWhiteBinding(): EffectBinding<NoParams> {
  return nonConfigurable(blackAndWhiteDescriptor(), blackAndWhiteCpu);
}

/** The host binding of Sepia: its descriptor, parameter reader and CPU reference. */
export function sepiaBinding(): EffectBinding<SepiaParams> {
  return {
    descriptor: sepiaDescriptor(),
    params: sepiaParams,
    cpu: sepiaCpu,
  };
}

function nonConfigurable(
  descriptor: EffectDescriptor,
  cpu: (input: Surface) => Surface,
): EffectBinding<NoParams> {
  return { descriptor, params: () => ({}), cpu };
}

/**
 * What the WGSL twin needs. `op` selects the adjustment. The other fields hold the numbers that
 * the Rust reference computes, so both sides use the same f32 values, and they are neutral when
 * the adjustment does not read them.
 */
export interface AdjustmentPlan {
  readonly op: number;
  /** Sepia exponents for R, G and B (1 when unused). */
  readonly exponents: Float32Array;
  /**
   * Levels per channel as input black, input white, gamma, output black and output white, for R, G
   * and B in turn (identity when unused). The Rust `LevelsPlan` holds the same layout.
   */
  readonly levels: Float32Array;
  /** Brightness / Contrast as shift, multiplier and divisor (identity when unused). */
  readonly brightnessContrast: Float32Array;
  /** Hue turn, saturation factor, lightness weight and lightness target (identity when unused). */
  readonly hueSaturation: Float32Array;
  /** Posterize levels for R, G, B and A, 0 for an unchanged channel (identity when unused). */
  readonly posterize: Float32Array;
  /** Curves tables, `CURVE_LUT_SIZE` entries each (identity when unused). See `curve_lut`. */
  readonly curves: Float32Array;
  /** Linear-light gains of R, G and B for Exposure and Temperature / Tint (1 when unused). */
  readonly gains: Float32Array;
  /**
   * Highlights, Shadows and Clarity as -1..1, then the blur radius in taps, which is the
   * half-length of `weights` (zero when unused). See `highlightsShadowsPlan`.
   */
  readonly tone: Float32Array;
  /** Symmetric blur weights for offsets -taps..=taps, zero-padded to `BLUR_WEIGHTS` (identity when unused). */
  readonly weights: Float32Array;
}

/** Identity Curves tables: entry k of each table is the input k / (CURVE_LUT_SIZE - 1). */
const IDENTITY_CURVES = Float32Array.from(
  { length: CURVE_TABLES * CURVE_LUT_SIZE },
  (_, index) => (index % CURVE_LUT_SIZE) / (CURVE_LUT_SIZE - 1),
);

/** Blur weight slots in the shader's `Params` (`weights`, eight vec4). A kernel holds at most 121 taps. */
export const BLUR_WEIGHTS = 128;

/** Pads a blur kernel into the `BLUR_WEIGHTS` slots that the shader reads. */
export function blurWeightsOf(kernel: ArrayLike<number>): Float32Array {
  const weights = new Float32Array(BLUR_WEIGHTS);
  weights.set(Float32Array.from(kernel));
  return weights;
}

/** A plan that leaves the pixels unchanged, with the op of one adjustment. */
export function identityPlan(op: number): AdjustmentPlan {
  return {
    op,
    exponents: Float32Array.of(1, 1, 1),
    levels: Float32Array.of(0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1),
    brightnessContrast: Float32Array.of(0, 1, 1),
    hueSaturation: Float32Array.of(0, 1, 0, 0),
    posterize: Float32Array.of(0, 0, 0, 0),
    curves: IDENTITY_CURVES,
    gains: Float32Array.of(1, 1, 1),
    tone: Float32Array.of(0, 0, 0, 0),
    weights: blurWeightsOf([1]),
  };
}

/** Requires the Rust/WASM kernels to be initialized (`initCpu` in `@openpaint/engine`). */
export function planAdjustment(id: AdjustmentId, intensity: number): AdjustmentPlan {
  const plan = identityPlan(ADJUSTMENT_OPS[id]);
  return id === "sepia"
    ? { ...plan, exponents: Float32Array.from(sepia_exponents(intensity)) }
    : plan;
}

/** The straight-alpha RGBA8 bytes of a surface, without a copy. */
export function bytesOf(input: Surface): Uint8Array {
  return new Uint8Array(input.data.buffer, input.data.byteOffset, input.data.byteLength);
}

/** A surface of the same size as `input`, holding `bytes`. */
export function rgbaSurface(input: Surface, bytes: Uint8Array): Surface {
  return new Surface(input.width, input.height, new Uint8ClampedArray(bytes));
}
