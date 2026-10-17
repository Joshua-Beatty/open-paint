import { zoom_blur_rgba8, zoom_plan } from "@openpaint/cpu";
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

export const ZOOM_BLUR_ID = "zoom-blur";

/** Parameters of Zoom Blur (FX-BLUR-ZOOM-02). */
export interface ZoomBlurParams {
  /** Zoom scale factor: below 1 zooms out, above 1 zooms in. */
  readonly distance: number;
  /** Exponent of the sample-weight falloff. Higher values keep the image sharper at its center. */
  readonly focus: number;
  /** Center offset from the document center, in half-document units. */
  readonly center: Vector2;
  /** Quality 1-8, one decimal. The sample count is floor(2^(Quality + 5)). */
  readonly quality: number;
  /** The document's size. Undefined means the region is the layer (FX-BLUR-ZOOM-03). */
  readonly document: EffectDocumentSize | undefined;
  /** Where the region sits in the document. Undefined reads as (0, 0). */
  readonly regionOrigin: EffectRegionOrigin | undefined;
}

/**
 * The Zoom Blur schema (FX-BLUR-ZOOM-02). The Quality default is the factory Default Quality Level
 * (FX-A-00-03 case 2), a decimal slider.
 */
export function zoomBlurSchema(factoryQuality: number): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "double",
        key: "distance",
        label: "property.distance",
        defaultValue: 1.25,
        min: 0.25,
        max: 4,
      },
      {
        kind: "double",
        key: "focus",
        label: "property.focus",
        defaultValue: 2,
        min: 1,
        max: 4,
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

export function zoomBlurDescriptor(factoryQuality: number): EffectDescriptor {
  return {
    id: ZOOM_BLUR_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.zoomBlur",
    icon: "icon.zoomBlur",
    category: "effect",
    submenu: "blurs",
    configurable: true,
    kind: "gpuImage",
    schema: zoomBlurSchema(factoryQuality),
    options: { gpu: { workingSpace: "linear", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Zoom Blur's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function zoomBlurParams(
  values: PropertyValues,
  factoryQuality: number,
  document?: EffectDocumentSize,
  regionOrigin?: EffectRegionOrigin,
): ZoomBlurParams {
  const resolved = resolveValues(zoomBlurSchema(factoryQuality), values);
  return {
    distance: numberValue(resolved, "distance"),
    focus: numberValue(resolved, "focus"),
    center: vector2Value(resolved, "center"),
    quality: numberValue(resolved, "quality"),
    document,
    regionOrigin,
  };
}

/**
 * The scales of Zoom Blur as `scale, weight` pairs (FX-BLUR-ZOOM-03). Empty at distance 1. Requires
 * the WASM kernels to be initialized.
 */
export function zoomBlurPlan(params: ZoomBlurParams): Float32Array {
  return zoom_plan(params.distance, params.focus, params.quality);
}

/** The Rust reference of Zoom Blur (FX-BLUR-ZOOM-03): returns the blurred `input`. */
export function zoomBlurCpu(input: Surface, params: ZoomBlurParams): Surface {
  const out = zoom_blur_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    documentCenter(params.center, input.width, input.height, params.document, params.regionOrigin),
    zoomBlurPlan(params),
  );
  return distortedSurface(input, out);
}

/**
 * The host binding of Zoom Blur: its descriptor, parameter reader and CPU reference. The region's
 * place in the document centers the blur on the layer.
 */
export function zoomBlurBinding(factoryQuality: number): EffectBinding<ZoomBlurParams> {
  return {
    descriptor: zoomBlurDescriptor(factoryQuality),
    params: (values, document, _instanceSeed, regionOrigin) =>
      zoomBlurParams(values, factoryQuality, document, regionOrigin),
    cpu: zoomBlurCpu,
  };
}
