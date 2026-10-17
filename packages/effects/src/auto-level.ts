import { auto_level_plan, auto_level_rgba8 } from "@openpaint/cpu";
import type { Surface } from "@openpaint/document";
import type { EffectDescriptor } from "@openpaint/extension-api";
import { definePropertySchema } from "@openpaint/properties";
import {
  type AdjustmentPlan,
  adjustmentDescriptor,
  bytesOf,
  identityPlan,
  type NoParams,
  rgbaSurface,
} from "./adjustments";
import type { EffectBinding } from "./framework/binding";

export const AUTO_LEVEL_ID = "autoLevel";
/** The op code the WGSL twin switches on for Auto-Level (`ADJUSTMENTS_WGSL`). */
export const AUTO_LEVEL_OP = 4;

/** Auto-Level has no parameters, so it has no dialog (ADJ-COMMON-01). */
export function autoLevelDescriptor(): EffectDescriptor {
  return adjustmentDescriptor(
    AUTO_LEVEL_ID,
    "effect.autoLevel",
    "icon.autoLevel",
    false,
    definePropertySchema({ properties: [] }),
  );
}

/**
 * The coverage bytes the kernels take: one byte per pixel of `input`. Undefined means every pixel
 * is selected, which is the whole layer when nothing is selected (ADJ-COMMON-05).
 */
export function coverageBytes(input: Surface, coverage: ArrayLike<number> | undefined): Uint8Array {
  const pixels = input.width * input.height;
  if (coverage === undefined) return new Uint8Array(pixels).fill(255);
  return Uint8Array.from(coverage);
}

/**
 * The Rust reference of Auto-Level (ADJ-AUTOLEVEL-01). The histograms read only the covered pixels,
 * so pixels outside the selection do not move the black point, white point or gamma.
 */
export function autoLevelCpu(input: Surface, coverage?: ArrayLike<number>): Surface {
  return rgbaSurface(input, auto_level_rgba8(bytesOf(input), coverageBytes(input, coverage)));
}

/** The plan of Auto-Level for the WGSL twin: its black, white and gamma numbers from Rust. */
export function autoLevelPlan(input: Surface, coverage?: ArrayLike<number>): AdjustmentPlan {
  const levels = auto_level_plan(bytesOf(input), coverageBytes(input, coverage));
  return { ...identityPlan(AUTO_LEVEL_OP), levels: Float32Array.from(levels) };
}

/** The host binding of Auto-Level: its descriptor and CPU reference, with the selection. */
export function autoLevelBinding(): EffectBinding<NoParams> {
  return {
    descriptor: autoLevelDescriptor(),
    params: () => ({}),
    cpu: (input, _params, coverage) => autoLevelCpu(input, coverage),
  };
}
