import { exposure_gain, exposure_rgba8 } from "@openpaint/cpu";
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
  bytesOf,
  identityPlan,
  rgbaSurface,
} from "./adjustments";
import type { EffectBinding } from "./framework/binding";

export const EXPOSURE_ID = "exposure";
/** The op code the WGSL twin switches on for Exposure (`ADJUSTMENTS_WGSL`). */
export const EXPOSURE_OP = 10;

/** Parameters of Exposure (ADJ-EXPOSURE). The value is EV × 100, so −200..=200 is −2..+2 stops. */
export interface ExposureParams {
  readonly exposure: number;
}

/**
 * The Exposure schema (ADJ-EXPOSURE table): one integer slider from −200 to 200, default 0. Its
 * caption is blank by design, and the track runs from #202020 to #DFDFDF.
 */
export function exposureSchema(): PropertySchema {
  return adjustmentSchema({
    properties: [
      {
        kind: "int32",
        key: "exposure",
        label: "property.noCaption",
        defaultValue: 0,
        min: -200,
        max: 200,
        control: { controlColors: ["#202020", "#DFDFDF"] },
      },
    ],
  });
}

export function exposureDescriptor(): EffectDescriptor {
  return adjustmentDescriptor(
    EXPOSURE_ID,
    "effect.exposure",
    "icon.exposure",
    true,
    exposureSchema(),
  );
}

/** Reads Exposure parameters from property values, clamped to the schema. */
export function exposureParams(values: PropertyValues): ExposureParams {
  return { exposure: numberValue(resolveValues(exposureSchema(), values), "exposure") };
}

/** The Rust reference of Exposure (ADJ-EXPOSURE-01). The input is not modified. */
export function exposureCpu(input: Surface, params: ExposureParams): Surface {
  return rgbaSurface(input, exposure_rgba8(bytesOf(input), params.exposure));
}

/**
 * The plan of Exposure for the WGSL twin: the linear-light gain `2^EV` that the Rust reference
 * computes, on each of R, G and B.
 */
export function exposurePlan(params: ExposureParams): AdjustmentPlan {
  const gain = exposure_gain(params.exposure);
  return { ...identityPlan(EXPOSURE_OP), gains: Float32Array.of(gain, gain, gain) };
}

/** The host binding of Exposure: its descriptor, parameter reader and CPU reference. */
export function exposureBinding(): EffectBinding<ExposureParams> {
  return {
    descriptor: exposureDescriptor(),
    params: exposureParams,
    cpu: exposureCpu,
  };
}
