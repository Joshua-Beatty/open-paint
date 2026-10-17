import { bulge_plan, bulge_rgba8 } from "@openpaint/cpu";
import type { Surface } from "@openpaint/document";
import { type EffectDescriptor, EXTENSION_API_MAJOR } from "@openpaint/extension-api";
import {
  definePropertySchema,
  numberValue,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
  type Vector2,
} from "@openpaint/properties";
import {
  distortedSurface,
  distortionQualityProperty,
  type EdgeBehavior,
  edgeBehaviorCode,
  edgeBehaviorOf,
  edgeBehaviorProperty,
  SOURCE_UNDERLAY_KEY,
  surfaceBytes,
  vector2Value,
} from "./distortion";
import type { EffectBinding } from "./framework/binding";

export const BULGE_ID = "bulge";

/** Bulge's declared default strength (FX-DIST-BULGE-02). */
export const BULGE_DEFAULT_STRENGTH = 0.45;

/** Parameters of Bulge (FX-DIST-BULGE-02). */
export interface BulgeParams {
  /** Strength: above 0 swells, below 0 pinches. */
  readonly bulge: number;
  /** Center offset from the center of the selection bounds, in half-bounds units. */
  readonly center: Vector2;
  readonly edge: EdgeBehavior;
  /** Supersampling Quality 1-8 (q² samples). */
  readonly quality: number;
}

/**
 * The Bulge schema (FX-DIST-BULGE-02). The Quality default is the Default Quality Level value
 * (FX-A-00-03 case 1).
 */
export function bulgeSchema(defaultQuality: number): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "double",
        key: "bulge",
        label: "property.bulge",
        defaultValue: BULGE_DEFAULT_STRENGTH,
        min: -3,
        max: 1,
      },
      {
        kind: "vector2",
        key: "center",
        label: "property.center",
        defaultValue: { x: 0, y: 0 },
        min: { x: -1, y: -1 },
        max: { x: 1, y: 1 },
        control: {
          sliderSmallChange: 0.05,
          sliderLargeChange: 0.25,
          upDownIncrement: 0.01,
          staticImageUnderlay: SOURCE_UNDERLAY_KEY,
        },
      },
      edgeBehaviorProperty("clamp"),
      distortionQualityProperty(defaultQuality),
    ],
  });
}

export function bulgeDescriptor(defaultQuality: number): EffectDescriptor {
  return {
    id: BULGE_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.bulge",
    icon: "icon.bulge",
    category: "effect",
    submenu: "distort",
    configurable: true,
    kind: "gpuImage",
    schema: bulgeSchema(defaultQuality),
    options: { gpu: { workingSpace: "linear", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Bulge's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function bulgeParams(values: PropertyValues, defaultQuality: number): BulgeParams {
  const resolved = resolveValues(bulgeSchema(defaultQuality), values);
  return {
    bulge: numberValue(resolved, "bulge"),
    center: vector2Value(resolved, "center"),
    edge: edgeBehaviorOf(resolved),
    quality: numberValue(resolved, "quality"),
  };
}

/**
 * The plan of Bulge for the sample map: `[cx, cy, radius, strength]` over the region, which is the
 * selection bounds. Requires the WASM kernels to be initialized.
 */
export function bulgePlan(params: BulgeParams, width: number, height: number): Float32Array {
  return bulge_plan(width, height, Float32Array.of(params.center.x, params.center.y), params.bulge);
}

/** The Rust reference of Bulge (FX-DIST-BULGE-03): returns the distorted `input` as a new surface. */
export function bulgeCpu(input: Surface, params: BulgeParams): Surface {
  const out = bulge_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    params.quality,
    edgeBehaviorCode(params.edge),
    bulgePlan(params, input.width, input.height),
  );
  return distortedSurface(input, out);
}

/** The host binding of Bulge: its descriptor, parameter reader and CPU reference. */
export function bulgeBinding(defaultQuality: number): EffectBinding<BulgeParams> {
  return {
    descriptor: bulgeDescriptor(defaultQuality),
    params: (values) => bulgeParams(values, defaultQuality),
    cpu: bulgeCpu,
  };
}
