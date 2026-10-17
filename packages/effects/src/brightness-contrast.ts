import { brightness_contrast_plan, brightness_contrast_rgba8 } from "@openpaint/cpu";
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

export const BRIGHTNESS_CONTRAST_ID = "brightnessContrast";
/** The op code the WGSL twin switches on for Brightness / Contrast (`ADJUSTMENTS_WGSL`). */
export const BRIGHTNESS_CONTRAST_OP = 5;

/** Parameters of Brightness / Contrast (ADJ-BC). Both are -100 to 100. */
export interface BrightnessContrastParams {
  readonly brightness: number;
  readonly contrast: number;
}

/** The Brightness / Contrast schema (ADJ-BC table): integer sliders from -100 to 100, default 0. */
export function brightnessContrastSchema(): PropertySchema {
  return adjustmentSchema({
    properties: [
      {
        kind: "int32",
        key: "brightness",
        label: "property.brightness",
        defaultValue: 0,
        min: -100,
        max: 100,
      },
      {
        kind: "int32",
        key: "contrast",
        label: "property.contrast",
        defaultValue: 0,
        min: -100,
        max: 100,
      },
    ],
  });
}

export function brightnessContrastDescriptor(): EffectDescriptor {
  return adjustmentDescriptor(
    BRIGHTNESS_CONTRAST_ID,
    "effect.brightnessContrast",
    "icon.brightnessContrast",
    true,
    brightnessContrastSchema(),
  );
}

/** Reads Brightness / Contrast parameters from property values, clamped to the schema. */
export function brightnessContrastParams(values: PropertyValues): BrightnessContrastParams {
  const resolved = resolveValues(brightnessContrastSchema(), values);
  return {
    brightness: numberValue(resolved, "brightness"),
    contrast: numberValue(resolved, "contrast"),
  };
}

/** The Rust reference of Brightness / Contrast (ADJ-BC-01). The input is not modified. */
export function brightnessContrastCpu(input: Surface, params: BrightnessContrastParams): Surface {
  return rgbaSurface(
    input,
    brightness_contrast_rgba8(bytesOf(input), params.brightness, params.contrast),
  );
}

/**
 * The plan of Brightness / Contrast for the WGSL twin: the shift, multiplier and divisor that the
 * Rust reference derives from the parameters.
 */
export function brightnessContrastPlan(params: BrightnessContrastParams): AdjustmentPlan {
  const values = brightness_contrast_plan(params.brightness, params.contrast);
  return {
    ...identityPlan(BRIGHTNESS_CONTRAST_OP),
    brightnessContrast: Float32Array.from(values),
  };
}

/** The host binding of Brightness / Contrast: its descriptor, parameter reader and CPU reference. */
export function brightnessContrastBinding(): EffectBinding<BrightnessContrastParams> {
  return {
    descriptor: brightnessContrastDescriptor(),
    params: brightnessContrastParams,
    cpu: brightnessContrastCpu,
  };
}
