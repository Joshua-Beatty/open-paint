import { julia_rgba8 } from "@openpaint/cpu";
import type { Surface } from "@openpaint/document";
import { type EffectDescriptor, EXTENSION_API_MAJOR } from "@openpaint/extension-api";
import {
  definePropertySchema,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
} from "@openpaint/properties";
import { distortedSurface, distortionQualityProperty, surfaceBytes } from "./distortion";
import {
  type FractalParams,
  fractalAngleProperty,
  fractalFactorProperty,
  fractalParamsOf,
  fractalPlan,
  fractalZoomProperty,
} from "./fractal";
import type { EffectBinding, EffectDocumentSize, EffectRegionOrigin } from "./framework/binding";
import { MIX_MODE_OVERWRITE, mixModeProperty } from "./mix-modes";

export const JULIA_ID = "julia";

/** Parameters of Julia (FX-RENDER-JULIA-01). */
export type JuliaParams = FractalParams;

/**
 * The Julia schema (FX-RENDER-JULIA-01), in the spec's order. The Quality default is the Default
 * Quality Level value (FX-FW-QUALITY-01).
 */
export function juliaSchema(defaultQuality: number): PropertySchema {
  return definePropertySchema({
    properties: [
      fractalFactorProperty(4),
      fractalZoomProperty(1, 0.1, 50),
      fractalAngleProperty(),
      distortionQualityProperty(defaultQuality),
      mixModeProperty(MIX_MODE_OVERWRITE),
    ],
  });
}

export function juliaDescriptor(defaultQuality: number): EffectDescriptor {
  return {
    id: JULIA_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.julia",
    icon: "icon.julia",
    category: "effect",
    submenu: "render",
    configurable: true,
    kind: "gpuImage",
    schema: juliaSchema(defaultQuality),
    options: { gpu: { workingSpace: "linear", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Julia's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function juliaParams(
  values: PropertyValues,
  defaultQuality: number,
  document?: EffectDocumentSize,
  regionOrigin?: EffectRegionOrigin,
): JuliaParams {
  return fractalParamsOf(
    resolveValues(juliaSchema(defaultQuality), values),
    document,
    regionOrigin,
  );
}

/** The Rust reference of Julia (FX-RENDER-JULIA-01): returns the composited `input` as a new surface. */
export function juliaCpu(input: Surface, params: JuliaParams): Surface {
  const out = julia_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    fractalPlan(params, input),
  );
  return distortedSurface(input, out);
}

/** The host binding of Julia: its descriptor, parameter reader and CPU reference. */
export function juliaBinding(defaultQuality: number): EffectBinding<JuliaParams> {
  return {
    descriptor: juliaDescriptor(defaultQuality),
    params: (values, document, _instanceSeed, regionOrigin) =>
      juliaParams(values, defaultQuality, document, regionOrigin),
    cpu: juliaCpu,
  };
}
