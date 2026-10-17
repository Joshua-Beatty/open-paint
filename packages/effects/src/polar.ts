import { polar_plan, polar_rgba8 } from "@openpaint/cpu";
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
import type { EffectBinding, EffectDocumentSize } from "./framework/binding";

export const POLAR_INVERSION_ID = "polarInversion";

/** Polar Inversion's declared default edge mode (FX-DIST-POLAR-02). */
const POLAR_EDGE: EdgeBehavior = "reflect";

/** Parameters of Polar Inversion (FX-DIST-POLAR-02). */
export interface PolarInversionParams {
  /** Blend amount of the inversion, -8 to 8. At 1 the inversion is complete. */
  readonly scale: number;
  /** Center offset from the center of the selection bounds, in half-bounds units. */
  readonly offset: Vector2;
  readonly edge: EdgeBehavior;
  /** Supersampling Quality 1-8 (q² samples). */
  readonly quality: number;
  /**
   * The document's size, which scales the Scale (FX-DIST-POLAR-03). Undefined means the selection
   * is the document, so the Scale is not scaled.
   */
  readonly document: EffectDocumentSize | undefined;
}

/**
 * The Polar Inversion schema (FX-DIST-POLAR-02). The Quality default is the Default Quality Level
 * value (FX-A-00-03 case 1).
 */
export function polarInversionSchema(defaultQuality: number): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "double",
        key: "scale",
        label: "property.scale",
        defaultValue: 1,
        min: -8,
        max: 8,
        control: {
          useExponentialScale: true,
          sliderSmallChange: 0.05,
          sliderLargeChange: 0.25,
          upDownIncrement: 0.01,
        },
      },
      {
        kind: "vector2",
        key: "offset",
        label: "property.offset",
        defaultValue: { x: 0, y: 0 },
        min: { x: -2, y: -2 },
        max: { x: 2, y: 2 },
        control: {
          sliderSmallChange: 0.05,
          sliderLargeChange: 0.25,
          upDownIncrement: 0.01,
          staticImageUnderlay: SOURCE_UNDERLAY_KEY,
        },
      },
      edgeBehaviorProperty(POLAR_EDGE),
      distortionQualityProperty(defaultQuality),
    ],
  });
}

export function polarInversionDescriptor(defaultQuality: number): EffectDescriptor {
  return {
    id: POLAR_INVERSION_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.polarInversion",
    icon: "icon.polarInversion",
    category: "effect",
    submenu: "distort",
    configurable: true,
    kind: "gpuImage",
    schema: polarInversionSchema(defaultQuality),
    options: { gpu: { workingSpace: "linear", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Polar Inversion's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function polarInversionParams(
  values: PropertyValues,
  defaultQuality: number,
  document?: EffectDocumentSize,
): PolarInversionParams {
  const resolved = resolveValues(polarInversionSchema(defaultQuality), values);
  return {
    scale: numberValue(resolved, "scale"),
    offset: vector2Value(resolved, "offset"),
    edge: edgeBehaviorOf(resolved),
    quality: numberValue(resolved, "quality"),
    document,
  };
}

/**
 * The plan of Polar Inversion for the sample map: `[cx, cy, radius, scale]` over the region, which
 * is the selection bounds. Requires the WASM kernels to be initialized.
 */
export function polarInversionPlan(
  params: PolarInversionParams,
  width: number,
  height: number,
): Float32Array {
  const document = params.document ?? { width, height };
  return polar_plan(
    width,
    height,
    Float32Array.of(document.width, document.height),
    Float32Array.of(params.offset.x, params.offset.y),
    params.scale,
  );
}

/** The Rust reference of Polar Inversion (FX-DIST-POLAR-03): returns the distorted `input`. */
export function polarInversionCpu(input: Surface, params: PolarInversionParams): Surface {
  const out = polar_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    params.quality,
    edgeBehaviorCode(params.edge),
    polarInversionPlan(params, input.width, input.height),
  );
  return distortedSurface(input, out);
}

/** The host binding of Polar Inversion: its descriptor, parameter reader and CPU reference. */
export function polarInversionBinding(defaultQuality: number): EffectBinding<PolarInversionParams> {
  return {
    descriptor: polarInversionDescriptor(defaultQuality),
    params: (values, document) => polarInversionParams(values, defaultQuality, document),
    cpu: polarInversionCpu,
  };
}
