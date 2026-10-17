import { posterize_rgba8 } from "@openpaint/cpu";
import type { Surface } from "@openpaint/document";
import type { EffectDescriptor } from "@openpaint/extension-api";
import {
  numberValue,
  type PropertyDefinition,
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

export const POSTERIZE_ID = "posterize";
/** The op code the WGSL twin switches on for Posterize (`ADJUSTMENTS_WGSL`). */
export const POSTERIZE_OP = 7;
/** The level count every channel starts with (ADJ-POSTERIZE table). */
export const POSTERIZE_DEFAULT_LEVELS = 16;

/** The channels in property order: R, G, B and then alpha (ADJ-POSTERIZE table). */
const CHANNELS = ["red", "green", "blue", "alpha"] as const;

/**
 * Parameters of Posterize. `levels` holds the R, G, B and A level counts in that order. A count of
 * 0 means the channel is not posterized (its checkbox is off).
 */
export interface PosterizeParams {
  readonly levels: readonly number[];
}

/**
 * The Posterize schema (ADJ-POSTERIZE table). Each channel has a checkbox and a level slider from 2
 * to 64. The slider is read-only while its checkbox is off, and Linked copies one level to all four.
 * Alpha is off by default, so soft edges are not posterized.
 */
export function posterizeSchema(): PropertySchema {
  return adjustmentSchema({
    properties: [
      ...CHANNELS.flatMap((channel): PropertyDefinition[] => [
        {
          kind: "boolean",
          key: channel,
          label: `property.${channel}`,
          defaultValue: channel !== "alpha",
        },
        {
          kind: "int32",
          key: `${channel}Levels`,
          label: `property.${channel}Levels`,
          defaultValue: POSTERIZE_DEFAULT_LEVELS,
          min: 2,
          max: 64,
        },
      ]),
      { kind: "boolean", key: "linked", label: "property.linked", defaultValue: true },
    ],
    rules: [
      ...CHANNELS.map((channel) => ({
        kind: "readOnlyWhenBoolean" as const,
        target: `${channel}Levels`,
        source: channel,
      })),
      {
        kind: "linkValuesWhenBoolean",
        source: "linked",
        when: true,
        keys: CHANNELS.map((channel) => `${channel}Levels`),
      },
    ],
  });
}

export function posterizeDescriptor(): EffectDescriptor {
  return adjustmentDescriptor(
    POSTERIZE_ID,
    "effect.posterize",
    "icon.posterize",
    true,
    posterizeSchema(),
  );
}

/** Reads Posterize parameters from property values. A channel whose checkbox is off gets 0. */
export function posterizeParams(values: PropertyValues): PosterizeParams {
  const resolved = resolveValues(posterizeSchema(), values);
  return {
    levels: CHANNELS.map((channel) =>
      resolved[channel] === true ? numberValue(resolved, `${channel}Levels`) : 0,
    ),
  };
}

/** The Rust reference of Posterize (ADJ-POSTERIZE-01). The input is not modified. */
export function posterizeCpu(input: Surface, params: PosterizeParams): Surface {
  return rgbaSurface(input, posterize_rgba8(bytesOf(input), Uint32Array.from(params.levels)));
}

/** The plan of Posterize for the WGSL twin: the level count of each channel, 0 when unchanged. */
export function posterizePlan(params: PosterizeParams): AdjustmentPlan {
  return {
    ...identityPlan(POSTERIZE_OP),
    posterize: Float32Array.from(params.levels),
  };
}

/** The host binding of Posterize: its descriptor, parameter reader and CPU reference. */
export function posterizeBinding(): EffectBinding<PosterizeParams> {
  return {
    descriptor: posterizeDescriptor(),
    params: posterizeParams,
    cpu: posterizeCpu,
  };
}
