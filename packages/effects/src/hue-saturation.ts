import { hue_saturation_plan, hue_saturation_rgba8 } from "@openpaint/cpu";
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

export const HUE_SATURATION_ID = "hueSaturation";
/** The op code the WGSL twin switches on for Hue / Saturation (`ADJUSTMENTS_WGSL`). */
export const HUE_SATURATION_OP = 6;

/** Parameters of Hue / Saturation (ADJ-HUESAT). Hue is in degrees, saturation and lightness in percent. */
export interface HueSaturationParams {
  readonly hue: number;
  readonly saturation: number;
  readonly lightness: number;
}

/** The Hue / Saturation schema (ADJ-HUESAT table): three integer sliders with their defaults. */
export function hueSaturationSchema(): PropertySchema {
  return adjustmentSchema({
    properties: [
      {
        kind: "int32",
        key: "hue",
        label: "property.hue",
        defaultValue: 0,
        min: -180,
        max: 180,
        control: { controlStyle: "hueCentered", rangeWraps: true },
      },
      {
        kind: "int32",
        key: "saturation",
        label: "property.saturation",
        defaultValue: 100,
        min: 0,
        max: 200,
        control: { controlStyle: "saturationHue" },
      },
      {
        kind: "int32",
        key: "lightness",
        label: "property.lightness",
        defaultValue: 0,
        min: -100,
        max: 100,
        control: { controlColors: ["#000000", "#FFFFFF"] },
      },
    ],
  });
}

export function hueSaturationDescriptor(): EffectDescriptor {
  return adjustmentDescriptor(
    HUE_SATURATION_ID,
    "effect.hueSaturation",
    "icon.hueSaturation",
    true,
    hueSaturationSchema(),
  );
}

/** Reads Hue / Saturation parameters from property values, clamped to the schema. */
export function hueSaturationParams(values: PropertyValues): HueSaturationParams {
  const resolved = resolveValues(hueSaturationSchema(), values);
  return {
    hue: numberValue(resolved, "hue"),
    saturation: numberValue(resolved, "saturation"),
    lightness: numberValue(resolved, "lightness"),
  };
}

/** The Rust reference of Hue / Saturation (ADJ-HUESAT-01). The input is not modified. */
export function hueSaturationCpu(input: Surface, params: HueSaturationParams): Surface {
  return rgbaSurface(
    input,
    hue_saturation_rgba8(bytesOf(input), params.hue, params.saturation, params.lightness),
  );
}

/**
 * The plan of Hue / Saturation for the WGSL twin: the hue turn, saturation factor and lightness
 * weight and target that the Rust reference derives from the parameters.
 */
export function hueSaturationPlan(params: HueSaturationParams): AdjustmentPlan {
  const values = hue_saturation_plan(params.hue, params.saturation, params.lightness);
  return {
    ...identityPlan(HUE_SATURATION_OP),
    hueSaturation: Float32Array.from(values),
  };
}

/** The host binding of Hue / Saturation: its descriptor, parameter reader and CPU reference. */
export function hueSaturationBinding(): EffectBinding<HueSaturationParams> {
  return {
    descriptor: hueSaturationDescriptor(),
    params: hueSaturationParams,
    cpu: hueSaturationCpu,
  };
}
