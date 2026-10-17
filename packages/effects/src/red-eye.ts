import { red_eye_rgba8 } from "@openpaint/cpu";
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

export const RED_EYE_ID = "red-eye";

/** Parameters of Red Eye Removal (FX-PHOTO-REDEYE-01). */
export interface RedEyeParams {
  /** Strength, 1-5. */
  readonly strength: number;
}

/** The Red Eye Removal schema (FX-PHOTO-REDEYE-01). */
export function redEyeSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "int32",
        key: "strength",
        label: "property.strength",
        defaultValue: 3,
        min: 1,
        max: 5,
        control: { description: "property.redEyeHint" },
      },
    ],
  });
}

export function redEyeDescriptor(): EffectDescriptor {
  return {
    id: RED_EYE_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.redEye",
    icon: "icon.redEye",
    category: "effect",
    submenu: "photo",
    configurable: true,
    kind: "cpuRegion",
    schema: redEyeSchema(),
    options: { disableSelectionClipping: true },
  };
}

/** Reads Red Eye Removal's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function redEyeParams(values: PropertyValues): RedEyeParams {
  const resolved = resolveValues(redEyeSchema(), values);
  return { strength: numberValue(resolved, "strength") };
}

/**
 * The Rust reference of Red Eye Removal: returns the corrected `input` as a new surface. The effect
 * masks itself, so `coverage` (0-255 per pixel) is the selection, and undefined means the whole
 * image is selected (FX-FW-SEL-01).
 */
export function redEyeCpu(
  input: Surface,
  params: RedEyeParams,
  coverage?: ArrayLike<number>,
): Surface {
  const mask = coverage
    ? Uint8Array.from(coverage)
    : new Uint8Array(input.width * input.height).fill(255);
  const out = red_eye_rgba8(surfaceBytes(input), input.width, input.height, mask, params.strength);
  return distortedSurface(input, out);
}

/** The host binding of Red Eye Removal: its descriptor, parameter reader and CPU reference. */
export function redEyeBinding(): EffectBinding<RedEyeParams> {
  return {
    descriptor: redEyeDescriptor(),
    params: redEyeParams,
    cpu: redEyeCpu,
  };
}
