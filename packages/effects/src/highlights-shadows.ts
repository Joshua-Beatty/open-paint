import { gaussian_kernel, highlights_shadows_plan, highlights_shadows_rgba8 } from "@openpaint/cpu";
import type { Surface } from "@openpaint/document";
import type { EffectDescriptor } from "@openpaint/extension-api";
import {
  numberValue,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
} from "@openpaint/properties";
import {
  type AdjustmentPlan,
  adjustmentDescriptor,
  adjustmentSchema,
  blurWeightsOf,
  bytesOf,
  identityPlan,
  rgbaSurface,
} from "./adjustments";
import type { EffectBinding } from "./framework/binding";

export const HIGHLIGHTS_SHADOWS_ID = "highlightsShadows";
/** The op code the WGSL twin switches on for Highlights / Shadows (`ADJUSTMENTS_WGSL`). */
export const HIGHLIGHTS_SHADOWS_OP = 12;
/** The default Radius (ADJ-HS table). */
export const HIGHLIGHTS_SHADOWS_DEFAULT_RADIUS = 1.25;

/** Parameters of Highlights / Shadows (ADJ-HS). The three amounts are −100..=100, Radius is 0..=10. */
export interface HighlightsShadowsParams {
  readonly highlights: number;
  readonly shadows: number;
  readonly clarity: number;
  readonly radius: number;
}

/**
 * The Highlights / Shadows schema (ADJ-HS table). Radius is a double slider with a spin box that
 * steps by 1, a small slider step of 0.25 and a large step of 2.5, and two decimals.
 */
export function highlightsShadowsSchema(): PropertySchema {
  return adjustmentSchema({
    properties: [
      {
        kind: "int32",
        key: "highlights",
        label: "property.highlights",
        defaultValue: 0,
        min: -100,
        max: 100,
      },
      {
        kind: "int32",
        key: "shadows",
        label: "property.shadows",
        defaultValue: 0,
        min: -100,
        max: 100,
      },
      {
        kind: "int32",
        key: "clarity",
        label: "property.clarity",
        defaultValue: 0,
        min: -100,
        max: 100,
      },
      {
        kind: "double",
        key: "radius",
        label: "property.radius",
        defaultValue: HIGHLIGHTS_SHADOWS_DEFAULT_RADIUS,
        min: 0,
        max: 10,
        control: {
          decimalPlaces: 2,
          upDownIncrement: 1,
          sliderSmallChange: 0.25,
          sliderLargeChange: 2.5,
        },
      },
    ],
  });
}

export function highlightsShadowsDescriptor(): EffectDescriptor {
  return adjustmentDescriptor(
    HIGHLIGHTS_SHADOWS_ID,
    "effect.highlightsShadows",
    "icon.highlightsShadows",
    true,
    highlightsShadowsSchema(),
  );
}

/** Reads Highlights / Shadows parameters from property values, clamped to the schema. */
export function highlightsShadowsParams(values: PropertyValues): HighlightsShadowsParams {
  const resolved = resolveValues(highlightsShadowsSchema(), values);
  return {
    highlights: numberValue(resolved, "highlights"),
    shadows: numberValue(resolved, "shadows"),
    clarity: numberValue(resolved, "clarity"),
    radius: numberValue(resolved, "radius"),
  };
}

/** The Rust reference of Highlights / Shadows (ADJ-HS-02). The input is not modified. */
export function highlightsShadowsCpu(input: Surface, params: HighlightsShadowsParams): Surface {
  return rgbaSurface(
    input,
    highlights_shadows_rgba8(
      bytesOf(input),
      input.width,
      input.height,
      params.radius,
      params.highlights,
      params.shadows,
      params.clarity,
    ),
  );
}

/**
 * The plan of Highlights / Shadows for the WGSL twin. `tone` holds the three amounts as −1..1 and
 * then the blur radius in taps, which is half the length of the Gaussian kernel for σ = 2 × radius
 * (ADJ-HS-02 step 1). The blur itself runs on the GPU, in two passes.
 */
export function highlightsShadowsPlan(params: HighlightsShadowsParams): AdjustmentPlan {
  const tone = highlights_shadows_plan(params.highlights, params.shadows, params.clarity);
  const kernel = gaussian_kernel(Math.fround(2 * params.radius));
  const taps = (kernel.length - 1) / 2;
  return {
    ...identityPlan(HIGHLIGHTS_SHADOWS_OP),
    tone: Float32Array.from([...tone, taps]),
    weights: blurWeightsOf(kernel),
  };
}

/** The host binding of Highlights / Shadows: its descriptor, parameter reader and CPU reference. */
export function highlightsShadowsBinding(): EffectBinding<HighlightsShadowsParams> {
  return {
    descriptor: highlightsShadowsDescriptor(),
    params: highlightsShadowsParams,
    cpu: highlightsShadowsCpu,
  };
}
