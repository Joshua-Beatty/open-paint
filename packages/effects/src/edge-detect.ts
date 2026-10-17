import { edge_blur_weights, edge_detect_gain, edge_detect_rgba8 } from "@openpaint/cpu";
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

export const EDGE_DETECT_ID = "edge-detect";

/** The Algorithm choices in dialog order (FX-STYL-EDGE-01). */
export const EDGE_DETECT_ALGORITHMS = ["sobel", "prewitt"] as const;

export type EdgeDetectAlgorithm = (typeof EDGE_DETECT_ALGORITHMS)[number];

/** Parameters of Edge Detect (FX-STYL-EDGE-01). */
export interface EdgeDetectParams {
  /** Strength, 0-1. Scales the edge values. */
  readonly strength: number;
  /** Blurring, 0-10. The Gaussian pre-blur, with σ = Blurring / 3. */
  readonly blurring: number;
  /** The gradient kernel: Sobel or Prewitt. */
  readonly algorithm: EdgeDetectAlgorithm;
  /** Whether the edges are drawn over the original image instead of replacing it. */
  readonly overlayEdges: boolean;
}

/** The Edge Detect schema (FX-STYL-EDGE-01), in the dialog order of the spec. */
export function edgeDetectSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "double",
        key: "strength",
        label: "property.strength",
        defaultValue: 0.5,
        min: 0,
        max: 1,
        control: {
          decimalPlaces: 2,
          upDownIncrement: 0.01,
          sliderSmallChange: 0.05,
          sliderLargeChange: 0.2,
        },
      },
      {
        kind: "double",
        key: "blurring",
        label: "property.blurring",
        defaultValue: 0,
        min: 0,
        max: 10,
        control: {
          decimalPlaces: 2,
          useExponentialScale: true,
          upDownIncrement: 1,
          sliderSmallChange: 0.25,
          sliderLargeChange: 1,
        },
      },
      {
        kind: "choice",
        key: "algorithm",
        label: "property.noCaption",
        defaultValue: "sobel",
        options: [
          { value: "sobel", label: "edgeAlgorithm.sobel" },
          { value: "prewitt", label: "edgeAlgorithm.prewitt" },
        ],
        control: { description: "property.algorithm" },
      },
      {
        kind: "boolean",
        key: "overlayEdges",
        label: "property.noCaption",
        defaultValue: false,
        control: { description: "property.overlayEdges" },
      },
    ],
  });
}

export function edgeDetectDescriptor(): EffectDescriptor {
  return {
    id: EDGE_DETECT_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.edgeDetect",
    icon: "icon.edgeDetect",
    category: "effect",
    submenu: "stylize",
    configurable: true,
    kind: "gpuImage",
    schema: edgeDetectSchema(),
    options: { gpu: { workingSpace: "document", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** The algorithm of a parameter set. The schema has already checked the value. */
function algorithmOf(values: PropertyValues): EdgeDetectAlgorithm {
  const algorithm = EDGE_DETECT_ALGORITHMS.find((candidate) => candidate === values.algorithm);
  if (algorithm === undefined)
    throw new TypeError('Property "algorithm" is not an edge algorithm.');
  return algorithm;
}

/** Reads Edge Detect's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function edgeDetectParams(values: PropertyValues): EdgeDetectParams {
  const resolved = resolveValues(edgeDetectSchema(), values);
  return {
    strength: numberValue(resolved, "strength"),
    blurring: numberValue(resolved, "blurring"),
    algorithm: algorithmOf(resolved),
    overlayEdges: resolved.overlayEdges === true,
  };
}

/**
 * The numbers both backends compute from the parameters: the edge gain and the pre-blur kernel
 * (from the Rust reference), and the flags the shader reads. Requires the WASM kernels to be
 * initialized.
 */
export interface EdgeDetectPlan {
  readonly gain: number;
  readonly weights: Float32Array;
  readonly radius: number;
  readonly blurred: boolean;
  /** Bit 0 selects Prewitt, bit 1 the overlay. */
  readonly flags: number;
}

export function planEdgeDetect(params: EdgeDetectParams): EdgeDetectPlan {
  const prewitt = params.algorithm === "prewitt";
  const weights = edge_blur_weights(params.blurring);
  return {
    gain: edge_detect_gain(params.strength, prewitt),
    weights,
    radius: (weights.length - 1) / 2,
    blurred: params.blurring > 0,
    flags: (prewitt ? 1 : 0) | (params.overlayEdges ? 2 : 0),
  };
}

/** The Rust reference of Edge Detect: returns the edge map or the overlay as a new surface. */
export function edgeDetectCpu(input: Surface, params: EdgeDetectParams): Surface {
  const out = edge_detect_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    params.strength,
    params.blurring,
    params.algorithm === "prewitt",
    params.overlayEdges,
  );
  return distortedSurface(input, out);
}

/** The host binding of Edge Detect: its descriptor, parameter reader and CPU reference. */
export function edgeDetectBinding(): EffectBinding<EdgeDetectParams> {
  return {
    descriptor: edgeDetectDescriptor(),
    params: edgeDetectParams,
    cpu: edgeDetectCpu,
  };
}
