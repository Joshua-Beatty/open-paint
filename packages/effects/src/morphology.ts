import { morphology_rgba8 } from "@openpaint/cpu";
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

export const MORPHOLOGY_ID = "morphology";

/** The Mode choices (FX-DIST-MORPH-02), in code order: the array index is the code the kernel takes. */
export const MORPHOLOGY_MODES = ["erode", "dilate"] as const;

export type MorphologyMode = (typeof MORPHOLOGY_MODES)[number];

/** Parameters of Morphology (FX-DIST-MORPH-02). */
export interface MorphologyParams {
  /** Half the kernel width: the window spans 2 × width pixels, centered on the pixel. */
  readonly width: number;
  /** Half the kernel height: the window spans 2 × height pixels, centered on the pixel. */
  readonly height: number;
  readonly mode: MorphologyMode;
}

/**
 * The Morphology schema (FX-DIST-MORPH-02). While Linked is checked, Width and Height stay equal.
 * Dilate is the default Mode.
 */
export function morphologySchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "int32",
        key: "width",
        label: "property.width",
        defaultValue: 5,
        min: 1,
        max: 100,
      },
      {
        kind: "int32",
        key: "height",
        label: "property.height",
        defaultValue: 5,
        min: 1,
        max: 100,
      },
      { kind: "boolean", key: "linked", label: "property.linked", defaultValue: true },
      {
        kind: "choice",
        key: "mode",
        label: "property.mode",
        defaultValue: "dilate",
        options: [
          { value: "erode", label: "morphology.erode" },
          { value: "dilate", label: "morphology.dilate" },
        ],
      },
    ],
    rules: [
      { kind: "linkValuesWhenBoolean", source: "linked", when: true, keys: ["width", "height"] },
    ],
  });
}

export function morphologyDescriptor(): EffectDescriptor {
  return {
    id: MORPHOLOGY_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.morphology",
    icon: "icon.morphology",
    category: "effect",
    submenu: "distort",
    configurable: true,
    kind: "gpuImage",
    schema: morphologySchema(),
    options: { gpu: { workingSpace: "linear", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Morphology's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function morphologyParams(values: PropertyValues): MorphologyParams {
  const resolved = resolveValues(morphologySchema(), values);
  const mode = MORPHOLOGY_MODES.find((candidate) => candidate === resolved.mode);
  return {
    width: numberValue(resolved, "width"),
    height: numberValue(resolved, "height"),
    mode: mode ?? "dilate",
  };
}

/** The kernel code of the Mode: its position in the Mode list (0 Erode, 1 Dilate). */
export function morphologyCode(params: MorphologyParams): number {
  return MORPHOLOGY_MODES.indexOf(params.mode);
}

/**
 * The Rust reference of Morphology (FX-DIST-MORPH-03): returns the morphed `input` as a new surface.
 * Requires the WASM kernels to be initialized.
 */
export function morphologyCpu(input: Surface, params: MorphologyParams): Surface {
  const out = morphology_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    params.width,
    params.height,
    morphologyCode(params),
  );
  return distortedSurface(input, out);
}

/** The host binding of Morphology: its descriptor, parameter reader and CPU reference. */
export function morphologyBinding(): EffectBinding<MorphologyParams> {
  return {
    descriptor: morphologyDescriptor(),
    params: morphologyParams,
    cpu: morphologyCpu,
  };
}
