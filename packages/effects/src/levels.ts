import { auto_level_plan, levels_histogram_rgba8, levels_lut, levels_rgba8 } from "@openpaint/cpu";
import type { Surface } from "@openpaint/document";
import type { EffectDescriptor } from "@openpaint/extension-api";
import {
  definePropertySchema,
  type PropertySchema,
  type PropertyValue,
  type PropertyValues,
  resolveValues,
  type Vector3,
  type Vector3Property,
} from "@openpaint/properties";
import {
  type AdjustmentPlan,
  adjustmentDescriptor,
  bytesOf,
  identityPlan,
  rgbaSurface,
} from "./adjustments";
import { coverageBytes } from "./auto-level";
import type { EffectBinding } from "./framework/binding";

export const LEVELS_ID = "levels";
/** The op code of the WGSL twin for the Levels transform with planned points (`ADJUSTMENTS_WGSL`). */
export const LEVELS_OP = 4;
/** The custom dialog that edits Levels, registered by the UI (ADJ-LEVELS-UI, EXT-V1-02). */
export const LEVELS_DIALOG_ID = "levels";
/** The gamma range (ADJ-LEVELS-PARAMS). */
export const LEVELS_GAMMA_MIN = 0.1;
export const LEVELS_GAMMA_MAX = 10;

/** One value for each of R, G and B. */
export type ChannelTriple = readonly [number, number, number];

/** Levels parameters (ADJ-LEVELS-PARAMS). Points are 0..1, and gamma is 0.1..10 per channel. */
export interface LevelsParams {
  readonly inputBlack: ChannelTriple;
  readonly inputWhite: ChannelTriple;
  readonly gamma: ChannelTriple;
  readonly outputBlack: ChannelTriple;
  readonly outputWhite: ChannelTriple;
}

/** The identity Levels parameters (ADJ-LEVELS-PARAMS defaults). */
export const LEVELS_IDENTITY: LevelsParams = {
  inputBlack: [0, 0, 0],
  inputWhite: [1, 1, 1],
  gamma: [1, 1, 1],
  outputBlack: [0, 0, 0],
  outputWhite: [1, 1, 1],
};

type Label = Vector3Property["label"];

function channelsProperty(
  key: keyof LevelsParams,
  label: Label,
  min: number,
  max: number,
): Vector3Property {
  const defaults = LEVELS_IDENTITY[key];
  return {
    kind: "vector3",
    key,
    label,
    defaultValue: toVector(defaults),
    min: { x: min, y: min, z: min },
    max: { x: max, y: max, z: max },
  };
}

/**
 * The Levels schema (ADJ-LEVELS-PARAMS). Each parameter is a triple, one value for each of R, G and
 * B. The custom dialog edits it, and the schema remembers and validates it (ADJ-COMMON-07).
 */
export function levelsSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      channelsProperty("inputBlack", "property.inputBlack", 0, 1),
      channelsProperty("inputWhite", "property.inputWhite", 0, 1),
      channelsProperty("gamma", "property.gamma", LEVELS_GAMMA_MIN, LEVELS_GAMMA_MAX),
      channelsProperty("outputBlack", "property.outputBlack", 0, 1),
      channelsProperty("outputWhite", "property.outputWhite", 0, 1),
    ],
  });
}

/** Levels: an adjustment with a custom dialog, so the menu item ends in "..." (ADJ-MENU-03). */
export function levelsDescriptor(): EffectDescriptor {
  return {
    ...adjustmentDescriptor(LEVELS_ID, "effect.levels", "icon.levels", true, levelsSchema()),
    customDialog: LEVELS_DIALOG_ID,
  };
}

/** Reads the Levels parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function levelsParams(values: PropertyValues): LevelsParams {
  const resolved = resolveValues(levelsSchema(), values);
  return {
    inputBlack: channelsOf(resolved.inputBlack, LEVELS_IDENTITY.inputBlack),
    inputWhite: channelsOf(resolved.inputWhite, LEVELS_IDENTITY.inputWhite),
    gamma: channelsOf(resolved.gamma, LEVELS_IDENTITY.gamma),
    outputBlack: channelsOf(resolved.outputBlack, LEVELS_IDENTITY.outputBlack),
    outputWhite: channelsOf(resolved.outputWhite, LEVELS_IDENTITY.outputWhite),
  };
}

/** The property values of Levels parameters, as the schema and the settings store hold them. */
export function levelsValues(params: LevelsParams): PropertyValues {
  return {
    inputBlack: toVector(params.inputBlack),
    inputWhite: toVector(params.inputWhite),
    gamma: toVector(params.gamma),
    outputBlack: toVector(params.outputBlack),
    outputWhite: toVector(params.outputWhite),
  };
}

export function toVector(channels: ChannelTriple): Vector3 {
  return { x: channels[0], y: channels[1], z: channels[2] };
}

function channelsOf(value: PropertyValue | undefined, fallback: ChannelTriple): ChannelTriple {
  if (typeof value === "object" && value !== null && "z" in value) {
    return [value.x, value.y, value.z];
  }
  return fallback;
}

/** The five parameter groups in plan order: input black, input white, gamma, output black, white. */
export function levelsGroups(params: LevelsParams): readonly ChannelTriple[] {
  return [
    params.inputBlack,
    params.inputWhite,
    params.gamma,
    params.outputBlack,
    params.outputWhite,
  ];
}

/**
 * The Levels plan (ADJ-LEVELS-MATH): five values per channel, R then G then B, in the order input
 * black, input white, gamma, output black, output white. The Rust kernels and the WGSL twin read it.
 */
export function levelsPlanValues(params: LevelsParams): Float32Array {
  const plan = new Float32Array(15);
  levelsGroups(params).forEach((group, field) => {
    group.forEach((value, channel) => {
      plan[channel * 5 + field] = value;
    });
  });
  return plan;
}

/** The plan of the WGSL twin for Levels: the same numbers as the Rust reference. */
export function levelsPlan(params: LevelsParams): AdjustmentPlan {
  return { ...identityPlan(LEVELS_OP), levels: levelsPlanValues(params) };
}

/** The Rust reference of Levels (ADJ-LEVELS-MATH). The input is not modified. */
export function levelsCpu(input: Surface, params: LevelsParams): Surface {
  return rgbaSurface(input, levels_rgba8(bytesOf(input), levelsPlanValues(params)));
}

/**
 * The 768-entry Levels lookup table of `params` (see `levels_lut`): entry `channel * 256 + value`
 * is the output of `value` in that channel. The dialog re-bins its output histogram through it.
 */
export function levelsLut(params: LevelsParams): Uint8Array {
  return levels_lut(levelsPlanValues(params));
}

/**
 * The 256-bin histogram of each channel over the covered pixels, R then G then B (ADJ-LEVELS-UI-06).
 * With no coverage, every pixel counts.
 */
export function levelsHistogram(input: Surface, coverage?: ArrayLike<number>): Uint32Array {
  return levels_histogram_rgba8(bytesOf(input), coverageBytes(input, coverage));
}

/**
 * The Auto points as Levels parameters (ADJ-LEVELS-UI-08, ADJ-AUTOLEVEL-01): the input black and
 * white points and the gamma per channel, with the output running from 0 to 1.
 */
export function autoLevelParams(input: Surface, coverage?: ArrayLike<number>): LevelsParams {
  const plan = auto_level_plan(bytesOf(input), coverageBytes(input, coverage));
  const group = (field: number): ChannelTriple => [
    plan[field] ?? 0,
    plan[5 + field] ?? 0,
    plan[10 + field] ?? 0,
  ];
  return {
    inputBlack: group(0),
    inputWhite: group(1),
    gamma: group(2),
    outputBlack: group(3),
    outputWhite: group(4),
  };
}

/** The host binding of Levels: its descriptor, parameter reader and CPU reference. */
export function levelsBinding(): EffectBinding<LevelsParams> {
  return {
    descriptor: levelsDescriptor(),
    params: levelsParams,
    cpu: (input, params) => levelsCpu(input, params),
  };
}
