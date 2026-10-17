import { brightness_contrast_plan, pencil_sketch_rgba8 } from "@openpaint/cpu";
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

export const PENCIL_SKETCH_ID = "pencil-sketch";

/** Pencil Sketch's Gaussian quality (FX-ART-PENCIL-03). */
const PENCIL_BLUR_QUALITY = 3;

/** Parameters of Pencil Sketch (FX-ART-PENCIL-02). */
export interface PencilSketchParams {
  /** Pencil tip size, 1-20. The blur radius is 1.5 times this value. */
  readonly tipSize: number;
  /** Range, -20 to 20, used as value / 100 for the brightness and contrast. */
  readonly range: number;
}

/** The Pencil Sketch schema (FX-ART-PENCIL-02). */
export function pencilSketchSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "double",
        key: "tipSize",
        label: "property.pencilTipSize",
        defaultValue: 2,
        min: 1,
        max: 20,
      },
      {
        kind: "double",
        key: "range",
        label: "property.range",
        defaultValue: 0,
        min: -20,
        max: 20,
        control: { decimalPlaces: 1 },
      },
    ],
  });
}

export function pencilSketchDescriptor(): EffectDescriptor {
  return {
    id: PENCIL_SKETCH_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.pencilSketch",
    icon: "icon.pencilSketch",
    category: "effect",
    submenu: "artistic",
    configurable: true,
    kind: "gpuImage",
    schema: pencilSketchSchema(),
    options: { gpu: { workingSpace: "document", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Pencil Sketch's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function pencilSketchParams(values: PropertyValues): PencilSketchParams {
  const resolved = resolveValues(pencilSketchSchema(), values);
  return {
    tipSize: numberValue(resolved, "tipSize"),
    range: numberValue(resolved, "range"),
  };
}

/**
 * The numbers both backends compute from the parameters: the Gaussian radius and quality, and the
 * Brightness / Contrast plan of the blurred image. Brightness is Range + 1 and Contrast is its
 * negative, on the -100..100 scale (Range / 100 + 0.01 in the spec).
 */
export interface PencilSketchPlan {
  readonly blurRadius: number;
  readonly blurQuality: number;
  readonly plan: Float32Array;
}

/** Requires the Rust/WASM kernels to be initialized (`initCpu` in `@openpaint/engine`). */
export function planPencilSketch(params: PencilSketchParams): PencilSketchPlan {
  const shift = params.range + 1;
  return {
    blurRadius: Math.fround(1.5 * params.tipSize),
    blurQuality: PENCIL_BLUR_QUALITY,
    plan: brightness_contrast_plan(shift, -shift),
  };
}

/** The Rust reference of Pencil Sketch: returns the sketched `input` as a new surface. */
export function pencilSketchCpu(input: Surface, params: PencilSketchParams): Surface {
  const out = pencil_sketch_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    params.tipSize,
    params.range,
  );
  return distortedSurface(input, out);
}

/** The host binding of Pencil Sketch: its descriptor, parameter reader and CPU reference. */
export function pencilSketchBinding(): EffectBinding<PencilSketchParams> {
  return {
    descriptor: pencilSketchDescriptor(),
    params: pencilSketchParams,
    cpu: pencilSketchCpu,
  };
}
