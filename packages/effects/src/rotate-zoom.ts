import { rotate_zoom_plan, rotate_zoom_rgba8 } from "@openpaint/cpu";
import type { Surface } from "@openpaint/document";
import { type EffectDescriptor, EXTENSION_API_MAJOR } from "@openpaint/extension-api";
import {
  definePropertySchema,
  numberValue,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
  type Vector2,
  type Vector3,
} from "@openpaint/properties";
import {
  distortedSurface,
  distortionQualityProperty,
  surfaceBytes,
  vector2Value,
} from "./distortion";
import { type EffectBinding, LAYER_UNDERLAY_KEY } from "./framework/binding";

export const ROTATE_ZOOM_ID = "rotate-zoom";

/** The Sampling choices in dialog order (FX-NOSUB-ROTZOOM-01). The index is the engine's code. */
export const ROTATE_ZOOM_SAMPLING = ["bilinear", "nearestNeighbor"] as const;

/** The Tiling Mode choices in dialog order. The index is the engine's code (None, Repeat, Mirror). */
export const ROTATE_ZOOM_TILING = ["none", "repeat", "mirror"] as const;

export type RotateZoomSampling = (typeof ROTATE_ZOOM_SAMPLING)[number];
export type RotateZoomTiling = (typeof ROTATE_ZOOM_TILING)[number];

/** Parameters of Rotate / Zoom (FX-NOSUB-ROTZOOM-01). */
export interface RotateZoomParams {
  /** Roll / Rotate: the angle, the tilt direction (both -180 to 180 degrees) and the tilt (0 to 90). */
  readonly roll: Vector3;
  /** Pan, -10 to 10 on each axis. Ten units move the layer by half the region. */
  readonly pan: Vector2;
  /** Zoom, 0.06 to 16. */
  readonly zoom: number;
  readonly sampling: RotateZoomSampling;
  /** Quality 1-8, which sets the number of rotated-grid samples per pixel (Quality²). */
  readonly quality: number;
  readonly tiling: RotateZoomTiling;
}

/**
 * The Rotate / Zoom schema (FX-NOSUB-ROTZOOM-01), in UI order: Roll / Rotate, Pan, Zoom, Sampling,
 * Quality and Tiling Mode. The Quality default is the factory Default Quality Level. The Pan pad
 * has the layer underlay, since the effect works on the whole layer.
 */
export function rotateZoomSchema(defaultQuality: number): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "vector3",
        key: "roll",
        label: "property.rollRotate",
        defaultValue: { x: 0, y: 0, z: 0 },
        min: { x: -180, y: -180, z: 0 },
        max: { x: 180, y: 180, z: 90 },
      },
      {
        kind: "vector2",
        key: "pan",
        label: "property.pan",
        defaultValue: { x: 0, y: 0 },
        min: { x: -10, y: -10 },
        max: { x: 10, y: 10 },
        control: {
          sliderSmallChange: 0.1,
          sliderLargeChange: 1,
          upDownIncrement: 0.1,
          staticImageUnderlay: LAYER_UNDERLAY_KEY,
        },
      },
      {
        kind: "double",
        key: "zoom",
        label: "property.zoom",
        defaultValue: 1,
        min: 0.06,
        max: 16,
        control: {
          decimalPlaces: 2,
          useExponentialScale: true,
          sliderSmallChange: 0.01,
          sliderLargeChange: 0.1,
          upDownIncrement: 0.01,
        },
      },
      {
        kind: "choice",
        key: "sampling",
        label: "property.sampling",
        defaultValue: "bilinear",
        options: [
          { value: "bilinear", label: "interpolation.bilinear" },
          { value: "nearestNeighbor", label: "interpolation.nearestNeighbor" },
        ],
      },
      distortionQualityProperty(defaultQuality),
      {
        kind: "choice",
        key: "tiling",
        label: "property.tilingMode",
        defaultValue: "none",
        options: [
          { value: "none", label: "tiling.none" },
          { value: "repeat", label: "tiling.repeat" },
          { value: "mirror", label: "tiling.mirror" },
        ],
      },
    ],
  });
}

export function rotateZoomDescriptor(defaultQuality: number): EffectDescriptor {
  return {
    id: ROTATE_ZOOM_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.rotateZoom",
    icon: "icon.rotateZoom",
    category: "hidden",
    configurable: true,
    kind: "gpuImage",
    schema: rotateZoomSchema(defaultQuality),
    options: { gpu: { workingSpace: "document", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** An (x, y, z) triple of a parameter set, such as the roll. */
function vector3Value(values: PropertyValues, key: string): Vector3 {
  const value = values[key];
  if (typeof value === "object" && "x" in value && "y" in value && "z" in value) {
    return { x: value.x, y: value.y, z: value.z };
  }
  throw new TypeError(`Property "${key}" is not an (x, y, z) triple.`);
}

/** The sampling of a parameter set. The schema has already checked the value. */
function samplingOf(values: PropertyValues): RotateZoomSampling {
  const sampling = ROTATE_ZOOM_SAMPLING.find((candidate) => candidate === values.sampling);
  if (sampling === undefined) throw new TypeError('Property "sampling" is not a sampling mode.');
  return sampling;
}

/** The tiling of a parameter set. The schema has already checked the value. */
function tilingOf(values: PropertyValues): RotateZoomTiling {
  const tiling = ROTATE_ZOOM_TILING.find((candidate) => candidate === values.tiling);
  if (tiling === undefined) throw new TypeError('Property "tiling" is not a tiling mode.');
  return tiling;
}

/** Reads Rotate / Zoom's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function rotateZoomParams(values: PropertyValues, defaultQuality: number): RotateZoomParams {
  const resolved = resolveValues(rotateZoomSchema(defaultQuality), values);
  return {
    roll: vector3Value(resolved, "roll"),
    pan: vector2Value(resolved, "pan"),
    zoom: numberValue(resolved, "zoom"),
    sampling: samplingOf(resolved),
    quality: numberValue(resolved, "quality"),
    tiling: tilingOf(resolved),
  };
}

/** The sampling code the engines take: its index in `ROTATE_ZOOM_SAMPLING`. */
export function rotateZoomSamplingCode(sampling: RotateZoomSampling): number {
  return ROTATE_ZOOM_SAMPLING.indexOf(sampling);
}

/** The tiling code the engines take: its index in `ROTATE_ZOOM_TILING`. */
export function rotateZoomTilingCode(tiling: RotateZoomTiling): number {
  return ROTATE_ZOOM_TILING.indexOf(tiling);
}

/**
 * The plan both backends use for a region: the row-major rotation, the focal length, the pan in
 * pixels and the zoom (from the Rust `rotate_zoom_plan`). Requires the WASM kernels to be initialized.
 */
export function planRotateZoom(
  params: RotateZoomParams,
  width: number,
  height: number,
): Float32Array {
  return rotate_zoom_plan(
    width,
    height,
    Float32Array.of(params.roll.x, params.roll.y, params.roll.z),
    Float32Array.of(params.pan.x, params.pan.y),
    params.zoom,
  );
}

/** The Rust reference of Rotate / Zoom (FX-NOSUB-ROTZOOM-01): returns the rolled `input` as a new surface. */
export function rotateZoomCpu(input: Surface, params: RotateZoomParams): Surface {
  const out = rotate_zoom_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    planRotateZoom(params, input.width, input.height),
    params.quality,
    rotateZoomSamplingCode(params.sampling),
    rotateZoomTilingCode(params.tiling),
  );
  return distortedSurface(input, out);
}

/** The host binding of Rotate / Zoom: its hidden descriptor, parameter reader and CPU reference. */
export function rotateZoomBinding(defaultQuality: number): EffectBinding<RotateZoomParams> {
  return {
    descriptor: rotateZoomDescriptor(defaultQuality),
    params: (values) => rotateZoomParams(values, defaultQuality),
    cpu: rotateZoomCpu,
  };
}
