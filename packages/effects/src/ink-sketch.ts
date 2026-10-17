import { brightness_contrast_plan, ink_sketch_rgba8 } from "@openpaint/cpu";
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
import { GLOW_QUALITY, GLOW_RADIUS_FACTOR } from "./glow";

export const INK_SKETCH_ID = "ink-sketch";

/** Glow's radius inside Ink Sketch (FX-ART-INK-03). */
const INK_GLOW_RADIUS = 6;

/** Parameters of Ink Sketch (FX-ART-INK-02). */
export interface InkSketchParams {
  /** Ink Outline, 0-99. The threshold is this value / 100. */
  readonly inkOutline: number;
  /** Coloring, 0-100. Sets the Glow's brightness and contrast. */
  readonly coloring: number;
}

/** The Ink Sketch schema (FX-ART-INK-02). */
export function inkSketchSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "int32",
        key: "inkOutline",
        label: "property.inkOutline",
        defaultValue: 50,
        min: 0,
        max: 99,
      },
      {
        kind: "int32",
        key: "coloring",
        label: "property.coloring",
        defaultValue: 50,
        min: 0,
        max: 100,
      },
    ],
  });
}

export function inkSketchDescriptor(): EffectDescriptor {
  return {
    id: INK_SKETCH_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.inkSketch",
    icon: "icon.inkSketch",
    category: "effect",
    submenu: "artistic",
    configurable: true,
    kind: "gpuImage",
    schema: inkSketchSchema(),
    options: { gpu: { workingSpace: "document", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Ink Sketch's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function inkSketchParams(values: PropertyValues): InkSketchParams {
  const resolved = resolveValues(inkSketchSchema(), values);
  return {
    inkOutline: numberValue(resolved, "inkOutline"),
    coloring: numberValue(resolved, "coloring"),
  };
}

/**
 * The numbers both backends compute from the parameters. The threshold is the ink cut-off on luma.
 * `brightness` and `contrast` are Glow's values on the Brightness / Contrast scale (-100..100), which
 * the WGSL twin reads as `bright`, `mul` and `div` (see `brightness_contrast_plan`).
 */
export interface InkSketchPlan {
  readonly threshold: number;
  readonly glowRadius: number;
  readonly glowQuality: number;
  /** The Brightness / Contrast plan of the Glow: shift, multiplier and divisor. */
  readonly glowPlan: Float32Array;
}

/** Requires the Rust/WASM kernels to be initialized (`initCpu` in `@openpaint/engine`). */
export function planInkSketch(params: InkSketchParams): InkSketchPlan {
  const shift = (50 - params.coloring) * 2;
  return {
    threshold: Math.fround(params.inkOutline / 100),
    glowRadius: Math.fround(INK_GLOW_RADIUS * GLOW_RADIUS_FACTOR),
    glowQuality: GLOW_QUALITY,
    glowPlan: brightness_contrast_plan(shift, shift),
  };
}

/** The Rust reference of Ink Sketch: returns the sketched `input` as a new surface. */
export function inkSketchCpu(input: Surface, params: InkSketchParams): Surface {
  const out = ink_sketch_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    params.inkOutline,
    params.coloring,
  );
  return distortedSurface(input, out);
}

/** The host binding of Ink Sketch: its descriptor, parameter reader and CPU reference. */
export function inkSketchBinding(): EffectBinding<InkSketchParams> {
  return {
    descriptor: inkSketchDescriptor(),
    params: inkSketchParams,
    cpu: inkSketchCpu,
  };
}
