import { clouds_permutation, clouds_rgba8 } from "@openpaint/cpu";
import type { Surface } from "@openpaint/document";
import { type EffectDescriptor, EXTENSION_API_MAJOR } from "@openpaint/extension-api";
import {
  type ColorValue,
  definePropertySchema,
  numberValue,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
} from "@openpaint/properties";
import { distortedSurface, surfaceBytes } from "./distortion";
import type {
  EffectBinding,
  EffectColors,
  EffectDocumentSize,
  EffectRegionOrigin,
} from "./framework/binding";
import { mixModeProperty } from "./mix-modes";
import { renderSeed, seedProperty } from "./rng";

export const CLOUDS_ID = "clouds";

/** The colors of a dialog that is opened without any: black and white (FX-RENDER-CLOUDS-01). */
const DEFAULT_COLORS: EffectColors = {
  primary: { r: 0, g: 0, b: 0, a: 1 },
  secondary: { r: 1, g: 1, b: 1, a: 1 },
};

/** The tab that holds Color 1 and Color 2 (FX-RENDER-CLOUDS-01). */
const TAB_KEY = "tab";

/** Parameters of Clouds (FX-RENDER-CLOUDS-01). */
export interface CloudsParams {
  /** Scale, 2-1000: the frequency divisor of the first octave. */
  readonly scale: number;
  /** Roughness, 0-1: the weight ratio between octaves. */
  readonly roughness: number;
  /** The blend mode code (FX-SHARED-MIXMODE). */
  readonly mode: number;
  /** The effective seed, 0-255: the user's Seed mixed with the instance seed (FX-A-00-05). */
  readonly seed: number;
  readonly color1: ColorValue;
  readonly color2: ColorValue;
  /** The region's top-left corner in document pixels. Undefined reads as (0, 0). */
  readonly origin: EffectRegionOrigin | undefined;
  /** The document size. Undefined reads as the input's own size. */
  readonly document: EffectDocumentSize | undefined;
}

/**
 * The Clouds schema (FX-RENDER-CLOUDS-01): a Clouds tab with Scale, Roughness, Blend Mode and Seed,
 * and a Colors tab with Color 1 and Color 2. The colors default to the given primary and secondary
 * colors, which the runtime passes when the dialog opens (FX-FW-TOKEN-01).
 */
export function cloudsSchema(colors: EffectColors = DEFAULT_COLORS): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "int32",
        key: "scale",
        label: "property.scale",
        defaultValue: 250,
        min: 2,
        max: 1000,
        control: { useExponentialScale: true },
      },
      {
        kind: "double",
        key: "roughness",
        label: "property.roughness",
        defaultValue: 0.5,
        min: 0,
        max: 1,
        control: {
          decimalPlaces: 2,
          upDownIncrement: 0.01,
          sliderSmallChange: 0.05,
          sliderLargeChange: 0.25,
        },
      },
      mixModeProperty(),
      seedProperty(),
      {
        kind: "color",
        key: "color1",
        label: "property.color1",
        defaultValue: colors.primary,
        alphaMode: "supportsAlpha",
      },
      {
        kind: "color",
        key: "color2",
        label: "property.color2",
        defaultValue: colors.secondary,
        alphaMode: "supportsAlpha",
      },
      {
        kind: "tabState",
        key: TAB_KEY,
        label: "property.noCaption",
        defaultValue: 0,
        tabCount: 2,
      },
    ],
    layout: [
      {
        kind: "tabs",
        key: TAB_KEY,
        pages: [
          {
            label: "property.tabClouds",
            children: [
              { kind: "control", key: "scale" },
              { kind: "control", key: "roughness" },
              { kind: "control", key: "blendMode" },
              { kind: "control", key: "seed" },
            ],
          },
          {
            label: "property.tabColors",
            children: [
              { kind: "control", key: "color1" },
              { kind: "control", key: "color2" },
            ],
          },
        ],
      },
    ],
  });
}

export function cloudsDescriptor(): EffectDescriptor {
  return {
    id: CLOUDS_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.clouds",
    icon: "icon.clouds",
    category: "effect",
    submenu: "render",
    configurable: true,
    kind: "gpuImage",
    schema: cloudsSchema(),
    options: { gpu: { workingSpace: "document", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

function colorOf(values: PropertyValues, key: string): ColorValue {
  const value = values[key];
  if (typeof value === "object" && "r" in value && "g" in value && "b" in value && "a" in value) {
    return { r: value.r, g: value.g, b: value.b, a: value.a };
  }
  throw new TypeError(`Property "${key}" is not a color.`);
}

/**
 * Reads Clouds' parameters from property values, clamped to the schema (FX-FW-TOKEN-01).
 * `instanceSeed` is mixed into the Seed (FX-A-00-05).
 */
export function cloudsParams(
  values: PropertyValues,
  document?: EffectDocumentSize,
  instanceSeed = 0,
  regionOrigin?: EffectRegionOrigin,
): CloudsParams {
  const resolved = resolveValues(cloudsSchema(), values);
  return {
    scale: numberValue(resolved, "scale"),
    roughness: numberValue(resolved, "roughness"),
    mode: numberValue(resolved, "blendMode"),
    seed: renderSeed(numberValue(resolved, "seed"), instanceSeed),
    color1: colorOf(resolved, "color1"),
    color2: colorOf(resolved, "color2"),
    origin: regionOrigin,
    document,
  };
}

/** The document size and origin an effect runs with: the input's own size when none is given. */
export function cloudsFrame(
  params: CloudsParams,
  input: Surface,
): { readonly document: EffectDocumentSize; readonly origin: EffectRegionOrigin } {
  return {
    document: params.document ?? { width: input.width, height: input.height },
    origin: params.origin ?? { x: 0, y: 0 },
  };
}

/**
 * The flat parameter array of `clouds_rgba8` (see `CloudsParams::from_plan` in Rust): origin x and y,
 * document width and height, scale, roughness, seed, mode, then Color 1 and Color 2 as RGBA.
 */
export function cloudsPlan(params: CloudsParams, input: Surface): Float32Array {
  const { document, origin } = cloudsFrame(params, input);
  const { color1: c1, color2: c2 } = params;
  return Float32Array.of(
    origin.x,
    origin.y,
    document.width,
    document.height,
    params.scale,
    params.roughness,
    params.seed,
    params.mode,
    c1.r,
    c1.g,
    c1.b,
    c1.a,
    c2.r,
    c2.g,
    c2.b,
    c2.a,
  );
}

/** The permutation table of the Clouds noise, which the WGSL twin reads (FX-RENDER-CLOUDS-01). */
export function cloudsPermutation(): Uint32Array {
  return clouds_permutation();
}

/** The Rust reference of Clouds (FX-RENDER-CLOUDS-01): returns the composited `input` as a new surface. */
export function cloudsCpu(input: Surface, params: CloudsParams): Surface {
  const out = clouds_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    cloudsPlan(params, input),
  );
  return distortedSurface(input, out);
}

/** The host binding of Clouds: its descriptor, parameter reader, CPU reference and open-time schema. */
export function cloudsBinding(): EffectBinding<CloudsParams> {
  return {
    descriptor: cloudsDescriptor(),
    params: cloudsParams,
    cpu: cloudsCpu,
    dialogSchema: (colors) => cloudsSchema(colors),
  };
}
