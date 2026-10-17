import { tile_plan, tile_rgba8 } from "@openpaint/cpu";
import type { Surface } from "@openpaint/document";
import { type EffectDescriptor, EXTENSION_API_MAJOR } from "@openpaint/extension-api";
import {
  definePropertySchema,
  numberValue,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
} from "@openpaint/properties";
import {
  distortedSurface,
  distortionQualityProperty,
  type EdgeBehavior,
  edgeBehaviorCode,
  edgeBehaviorOf,
  edgeBehaviorProperty,
  surfaceBytes,
} from "./distortion";
import type { EffectBinding, EffectDocumentSize, EffectRegionOrigin } from "./framework/binding";

export const TILE_REFLECTION_ID = "tileReflection";

/** Tile Reflection's declared default edge mode (FX-DIST-TILE-02). */
const TILE_EDGE: EdgeBehavior = "reflect";

/** Parameters of Tile Reflection (FX-DIST-TILE-02). */
export interface TileReflectionParams {
  /** Grid rotation in degrees, -180 to 180. */
  readonly angle: number;
  /** Tile size in pixels, 1 to 1600. */
  readonly tileSize: number;
  /** Surface curvature, -200 to 200. The sign gives the bulge direction. */
  readonly curvature: number;
  readonly edge: EdgeBehavior;
  /** Supersampling Quality 1-8 (q² samples). */
  readonly quality: number;
  /**
   * The document's size. The mirrored wall is centered on the whole layer (FX-DIST-TILE-03), so
   * the size gives that center. Undefined means the region is the layer.
   */
  readonly document: EffectDocumentSize | undefined;
  /** Where the region sits in the document. Undefined reads as (0, 0). */
  readonly regionOrigin: EffectRegionOrigin | undefined;
}

/**
 * The Tile Reflection schema (FX-DIST-TILE-02). The Quality default is the Default Quality Level
 * value (FX-A-00-03 case 1).
 */
export function tileReflectionSchema(defaultQuality: number): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "double",
        key: "angle",
        label: "property.angle",
        defaultValue: 30,
        min: -180,
        max: 180,
        control: { controlType: "anglePicker", rangeWraps: true, sliderLargeChange: 36 },
      },
      {
        kind: "double",
        key: "tileSize",
        label: "property.tileSize",
        defaultValue: 40,
        min: 1,
        max: 1600,
        control: { useExponentialScale: true },
      },
      {
        kind: "double",
        key: "curvature",
        label: "property.curvature",
        defaultValue: 8,
        min: -200,
        max: 200,
      },
      distortionQualityProperty(defaultQuality),
      edgeBehaviorProperty(TILE_EDGE),
    ],
  });
}

export function tileReflectionDescriptor(defaultQuality: number): EffectDescriptor {
  return {
    id: TILE_REFLECTION_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.tileReflection",
    icon: "icon.tileReflection",
    category: "effect",
    submenu: "distort",
    configurable: true,
    kind: "gpuImage",
    schema: tileReflectionSchema(defaultQuality),
    options: { gpu: { workingSpace: "linear", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Tile Reflection's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function tileReflectionParams(
  values: PropertyValues,
  defaultQuality: number,
  document?: EffectDocumentSize,
  regionOrigin?: EffectRegionOrigin,
): TileReflectionParams {
  const resolved = resolveValues(tileReflectionSchema(defaultQuality), values);
  return {
    angle: numberValue(resolved, "angle"),
    tileSize: numberValue(resolved, "tileSize"),
    curvature: numberValue(resolved, "curvature"),
    edge: edgeBehaviorOf(resolved),
    quality: numberValue(resolved, "quality"),
    document,
    regionOrigin,
  };
}

/**
 * The plan of Tile Reflection for the sample map: `[ox, oy, cos, sin, k, lambda]`. The origin is
 * the center of the whole layer, in the region's coordinates. Requires the WASM kernels to be
 * initialized.
 */
export function tileReflectionPlan(
  params: TileReflectionParams,
  width: number,
  height: number,
): Float32Array {
  const document = params.document ?? { width, height };
  const region = params.regionOrigin ?? { x: 0, y: 0 };
  return tile_plan(
    Float32Array.of(document.width / 2 - region.x, document.height / 2 - region.y),
    params.angle,
    params.tileSize,
    params.curvature,
  );
}

/** The Rust reference of Tile Reflection (FX-DIST-TILE-03): returns the distorted `input`. */
export function tileReflectionCpu(input: Surface, params: TileReflectionParams): Surface {
  const out = tile_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    params.quality,
    edgeBehaviorCode(params.edge),
    tileReflectionPlan(params, input.width, input.height),
  );
  return distortedSurface(input, out);
}

/**
 * The host binding of Tile Reflection: its descriptor, parameter reader and CPU reference. The
 * region's place in the document centers the mirrored wall on the layer.
 */
export function tileReflectionBinding(defaultQuality: number): EffectBinding<TileReflectionParams> {
  return {
    descriptor: tileReflectionDescriptor(defaultQuality),
    params: (values, document, _instanceSeed, regionOrigin) =>
      tileReflectionParams(values, defaultQuality, document, regionOrigin),
    cpu: tileReflectionCpu,
  };
}
