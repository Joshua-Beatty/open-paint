import { outline_rgba8 } from "@openpaint/cpu";
import type { Surface } from "@openpaint/document";
import { type EffectDescriptor, EXTENSION_API_MAJOR } from "@openpaint/extension-api";
import {
  definePropertySchema,
  numberValue,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
} from "@openpaint/properties";
import { distortedSurface, surfaceBytes } from "./distortion";
import type { EffectBinding } from "./framework/binding";

export const OUTLINE_ID = "outline";

/** Parameters of Outline (FX-STYL-OUTLINE-01). */
export interface OutlineParams {
  /** The radius of the neighborhood, 1-50. */
  readonly thickness: number;
  /** How far the two percentiles are apart, 0-100. */
  readonly intensity: number;
  /** Bits of precision of the percentile search, 1-12. */
  readonly quality: number;
}

/** The Outline schema (FX-STYL-OUTLINE-01), in the spec's order. */
export function outlineSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "int32",
        key: "thickness",
        label: "property.thickness",
        defaultValue: 3,
        min: 1,
        max: 50,
      },
      {
        kind: "int32",
        key: "intensity",
        label: "property.intensity",
        defaultValue: 50,
        min: 0,
        max: 100,
      },
      {
        kind: "int32",
        key: "quality",
        label: "property.quality",
        defaultValue: 8,
        min: 1,
        max: 12,
      },
    ],
  });
}

export function outlineDescriptor(): EffectDescriptor {
  return {
    id: OUTLINE_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.outline",
    icon: "icon.outline",
    category: "effect",
    submenu: "stylize",
    configurable: true,
    kind: "gpuImage",
    schema: outlineSchema(),
    options: { gpu: { workingSpace: "document", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Outline's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function outlineParams(values: PropertyValues): OutlineParams {
  const resolved = resolveValues(outlineSchema(), values);
  return {
    thickness: numberValue(resolved, "thickness"),
    intensity: numberValue(resolved, "intensity"),
    quality: numberValue(resolved, "quality"),
  };
}

/**
 * The two ranks of the percentile filters, in half-percent units (see `rank_estimate`): the low one is
 * `(1 − I)/2` and the high one `(1 + I)/2` with I = Intensity / 100, so `100 ∓ Intensity`.
 */
export interface OutlinePlan {
  readonly lowRank: number;
  readonly highRank: number;
}

export function planOutline(params: OutlineParams): OutlinePlan {
  return { lowRank: 100 - params.intensity, highRank: 100 + params.intensity };
}

/** The Rust reference of Outline (FX-STYL-OUTLINE): returns the outline image as a new surface. */
export function outlineCpu(input: Surface, params: OutlineParams): Surface {
  const out = outline_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    params.thickness,
    params.intensity,
    params.quality,
  );
  return distortedSurface(input, out);
}

/** The host binding of Outline: its descriptor, parameter reader and CPU reference. */
export function outlineBinding(): EffectBinding<OutlineParams> {
  return {
    descriptor: outlineDescriptor(),
    params: outlineParams,
    cpu: outlineCpu,
  };
}
