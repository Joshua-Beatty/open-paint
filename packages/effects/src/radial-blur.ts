import { radial_blur_rgba8, radial_plan } from "@openpaint/cpu";
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
import { distortedSurface, documentCenter, surfaceBytes, vector2Value } from "./distortion";
import {
  type EffectBinding,
  type EffectDocumentSize,
  type EffectRegionOrigin,
  LAYER_UNDERLAY_KEY,
} from "./framework/binding";

export const RADIAL_BLUR_ID = "radial-blur";

/** Parameters of Radial Blur (FX-BLUR-RADIAL-02). */
export interface RadialBlurParams {
  /** Total arc of the blur, in degrees, 0-360. */
  readonly angle: number;
  /** Center offset from the document center, in half-document units. */
  readonly center: Vector2;
  /** Quality 1-8, one decimal. The sample count is floor(2^(Quality + 5)). */
  readonly quality: number;
  /** The document's size. Undefined means the region is the layer (FX-BLUR-RADIAL-03). */
  readonly document: EffectDocumentSize | undefined;
  /** Where the region sits in the document. Undefined reads as (0, 0). */
  readonly regionOrigin: EffectRegionOrigin | undefined;
}

/**
 * The Radial Blur schema (FX-BLUR-RADIAL-02). The Quality default is the factory Default Quality
 * Level (FX-A-00-03 case 2), a decimal slider.
 */
export function radialBlurSchema(factoryQuality: number): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "double",
        key: "angle",
        label: "property.angle",
        defaultValue: 4,
        min: 0,
        max: 360,
        control: { controlType: "anglePicker", rangeWraps: true, sliderLargeChange: 36 },
      },
      {
        kind: "vector2",
        key: "center",
        label: "property.center",
        defaultValue: { x: 0, y: 0 },
        min: { x: -2, y: -2 },
        max: { x: 2, y: 2 },
        control: {
          sliderSmallChange: 0.05,
          sliderLargeChange: 0.25,
          upDownIncrement: 0.01,
          staticImageUnderlay: LAYER_UNDERLAY_KEY,
        },
      },
      {
        kind: "double",
        key: "quality",
        label: "property.quality",
        defaultValue: factoryQuality,
        min: 1,
        max: 8,
        control: { decimalPlaces: 1 },
      },
    ],
  });
}

export function radialBlurDescriptor(factoryQuality: number): EffectDescriptor {
  return {
    id: RADIAL_BLUR_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.radialBlur",
    icon: "icon.radialBlur",
    category: "effect",
    submenu: "blurs",
    configurable: true,
    kind: "gpuImage",
    schema: radialBlurSchema(factoryQuality),
    options: { gpu: { workingSpace: "linear", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Radial Blur's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function radialBlurParams(
  values: PropertyValues,
  factoryQuality: number,
  document?: EffectDocumentSize,
  regionOrigin?: EffectRegionOrigin,
): RadialBlurParams {
  const resolved = resolveValues(radialBlurSchema(factoryQuality), values);
  return {
    angle: numberValue(resolved, "angle"),
    center: vector2Value(resolved, "center"),
    quality: numberValue(resolved, "quality"),
    document,
    regionOrigin,
  };
}

/**
 * The rotations of Radial Blur as `cos, sin` pairs (FX-BLUR-RADIAL-03). Requires the WASM kernels to
 * be initialized.
 */
export function radialBlurPlan(params: RadialBlurParams): Float32Array {
  return radial_plan(params.angle, params.quality);
}

/** The Rust reference of Radial Blur (FX-BLUR-RADIAL-03): returns the blurred `input`. */
export function radialBlurCpu(input: Surface, params: RadialBlurParams): Surface {
  const out = radial_blur_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    documentCenter(params.center, input.width, input.height, params.document, params.regionOrigin),
    radialBlurPlan(params),
  );
  return distortedSurface(input, out);
}

/**
 * The host binding of Radial Blur: its descriptor, parameter reader and CPU reference. The region's
 * place in the document centers the blur on the layer.
 */
export function radialBlurBinding(factoryQuality: number): EffectBinding<RadialBlurParams> {
  return {
    descriptor: radialBlurDescriptor(factoryQuality),
    params: (values, document, _instanceSeed, regionOrigin) =>
      radialBlurParams(values, factoryQuality, document, regionOrigin),
    cpu: radialBlurCpu,
  };
}
