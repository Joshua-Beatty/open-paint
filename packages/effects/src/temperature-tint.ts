import { temperature_tint_gains, temperature_tint_rgba8 } from "@openpaint/cpu";
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

export const TEMPERATURE_TINT_ID = "temperatureTint";
/** The op code the WGSL twin switches on for Temperature / Tint (`ADJUSTMENTS_WGSL`). */
export const TEMPERATURE_TINT_OP = 11;

/** Parameters of Temperature / Tint (ADJ-TT). Both are −100..=100. */
export interface TemperatureTintParams {
  readonly temperature: number;
  readonly tint: number;
}

/**
 * The Temperature / Tint schema (ADJ-TT table): two integer sliders from −100 to 100, default 0.
 * Temperature runs azure, white, orange, and Tint runs pink-magenta, white, green.
 */
export function temperatureTintSchema(): PropertySchema {
  return adjustmentSchema({
    properties: [
      {
        kind: "int32",
        key: "temperature",
        label: "property.temperature",
        defaultValue: 0,
        min: -100,
        max: 100,
        control: { controlColors: ["#0080FF", "#FFFFFF", "#FF8000"] },
      },
      {
        kind: "int32",
        key: "tint",
        label: "property.tint",
        defaultValue: 0,
        min: -100,
        max: 100,
        control: { controlColors: ["#FF7FED", "#FFFFFF", "#80FF80"] },
      },
    ],
  });
}

export function temperatureTintDescriptor(): EffectDescriptor {
  return adjustmentDescriptor(
    TEMPERATURE_TINT_ID,
    "effect.temperatureTint",
    "icon.temperatureTint",
    true,
    temperatureTintSchema(),
  );
}

/** Reads Temperature / Tint parameters from property values, clamped to the schema. */
export function temperatureTintParams(values: PropertyValues): TemperatureTintParams {
  const resolved = resolveValues(temperatureTintSchema(), values);
  return {
    temperature: numberValue(resolved, "temperature"),
    tint: numberValue(resolved, "tint"),
  };
}

/** The Rust reference of Temperature / Tint (ADJ-TT-02). The input is not modified. */
export function temperatureTintCpu(input: Surface, params: TemperatureTintParams): Surface {
  return rgbaSurface(
    input,
    temperature_tint_rgba8(bytesOf(input), params.temperature, params.tint),
  );
}

/**
 * The plan of Temperature / Tint for the WGSL twin: the three linear-light gains that the Rust
 * reference derives from the parameters.
 */
export function temperatureTintPlan(params: TemperatureTintParams): AdjustmentPlan {
  const gains = temperature_tint_gains(params.temperature, params.tint);
  return { ...identityPlan(TEMPERATURE_TINT_OP), gains: Float32Array.from(gains) };
}

/** The host binding of Temperature / Tint: its descriptor, parameter reader and CPU reference. */
export function temperatureTintBinding(): EffectBinding<TemperatureTintParams> {
  return {
    descriptor: temperatureTintDescriptor(),
    params: temperatureTintParams,
    cpu: temperatureTintCpu,
  };
}
