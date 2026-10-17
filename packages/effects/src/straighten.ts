import { straighten_matrix, straighten_rgba8 } from "@openpaint/cpu";
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

export const STRAIGHTEN_ID = "straighten";

/** The Sampling choices in dialog order (FX-PHOTO-STRAIGHTEN-01). */
export const STRAIGHTEN_SAMPLING = ["bicubic", "bilinear", "nearestNeighbor"] as const;

export type StraightenSampling = (typeof STRAIGHTEN_SAMPLING)[number];

/** Parameters of Straighten (FX-PHOTO-STRAIGHTEN-01). */
export interface StraightenParams {
  /** Angle, -45 to 45 degrees. The layer turns by its negation. */
  readonly angle: number;
  /** How the rotated pixels are sampled. */
  readonly sampling: StraightenSampling;
}

/** The Straighten schema (FX-PHOTO-STRAIGHTEN-01): an angle chooser, then the Sampling drop-down. */
export function straightenSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "double",
        key: "angle",
        label: "property.angle",
        defaultValue: 0,
        min: -45,
        max: 45,
        control: { controlType: "anglePicker" },
      },
      {
        kind: "choice",
        key: "sampling",
        label: "property.noCaption",
        defaultValue: "bicubic",
        options: [
          { value: "bicubic", label: "interpolation.bicubic" },
          { value: "bilinear", label: "interpolation.bilinear" },
          { value: "nearestNeighbor", label: "interpolation.nearestNeighbor" },
        ],
        control: { description: "property.sampling" },
      },
    ],
  });
}

export function straightenDescriptor(): EffectDescriptor {
  return {
    id: STRAIGHTEN_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.straighten",
    icon: "icon.straighten",
    category: "effect",
    submenu: "photo",
    configurable: true,
    kind: "gpuImage",
    schema: straightenSchema(),
    options: { gpu: { workingSpace: "linear", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** The sampling of a parameter set. The schema has already checked the value. */
function samplingOf(values: PropertyValues): StraightenSampling {
  const sampling = STRAIGHTEN_SAMPLING.find((candidate) => candidate === values.sampling);
  if (sampling === undefined) throw new TypeError('Property "sampling" is not a sampling mode.');
  return sampling;
}

/** Reads Straighten's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function straightenParams(values: PropertyValues): StraightenParams {
  const resolved = resolveValues(straightenSchema(), values);
  return {
    angle: numberValue(resolved, "angle"),
    sampling: samplingOf(resolved),
  };
}

/** The sampling code the engines take: its index in `STRAIGHTEN_SAMPLING`. */
export function straightenSamplingCode(sampling: StraightenSampling): number {
  return STRAIGHTEN_SAMPLING.indexOf(sampling);
}

/**
 * The numbers both backends compute from the parameters for a region: the inverse matrix
 * `a, b, c, d, e, f` (from the Rust `straighten_matrix`) and the sampling code.
 */
export interface StraightenPlan {
  readonly matrix: Float32Array;
  readonly sampling: number;
}

/** Requires the Rust/WASM kernels to be initialized (`initCpu` in `@openpaint/engine`). */
export function planStraighten(
  params: StraightenParams,
  width: number,
  height: number,
): StraightenPlan {
  return {
    matrix: straighten_matrix(width, height, params.angle),
    sampling: straightenSamplingCode(params.sampling),
  };
}

/** The Rust reference of Straighten: returns the rotated, scaled `input` as a new surface. */
export function straightenCpu(input: Surface, params: StraightenParams): Surface {
  const out = straighten_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    params.angle,
    straightenSamplingCode(params.sampling),
  );
  return distortedSurface(input, out);
}

/** The host binding of Straighten: its descriptor, parameter reader and CPU reference. */
export function straightenBinding(): EffectBinding<StraightenParams> {
  return {
    descriptor: straightenDescriptor(),
    params: straightenParams,
    cpu: straightenCpu,
  };
}
