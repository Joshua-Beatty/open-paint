import type { Surface } from "@openpaint/document";
import { type AdjustmentPlan, planAdjustment, type SepiaParams, sepiaBinding } from "./adjustments";
import { brightnessContrastBinding, brightnessContrastPlan } from "./brightness-contrast";
import { curvesBinding, curvesPlan } from "./curves";
import { exposureBinding, exposurePlan } from "./exposure";
import type { EffectBinding } from "./framework/binding";
import { hueSaturationBinding, hueSaturationPlan } from "./hue-saturation";
import { levelsBinding, levelsPlan } from "./levels";
import { posterizeBinding, posterizePlan } from "./posterize";
import { temperatureTintBinding, temperatureTintPlan } from "./temperature-tint";

/**
 * A configurable adjustment that maps each pixel on its own, from the pixel and the parameters
 * alone: no neighbors and no analysis of the input. Its result over a part of a layer, or over a
 * downscaled copy, is the same part of its result over the whole layer, so the canvas can show it
 * as a live filter over the layer's pixels while its dialog is open (FX-FW-PREVIEW-01). `cpu` is
 * the Rust reference and `plan` feeds the WGSL twin (`ADJUST_PIXEL_WGSL`).
 */
export interface PixelAdjustment {
  cpu(input: Surface, params: unknown): Surface;
  plan(params: unknown): AdjustmentPlan;
}

function pixelwise<P>(
  binding: EffectBinding<P>,
  plan: (params: P) => AdjustmentPlan,
): [string, PixelAdjustment] {
  return [
    binding.descriptor.id,
    {
      cpu: (input, params) => binding.cpu(input, params as P),
      plan: (params) => plan(params as P),
    },
  ];
}

const PIXEL_ADJUSTMENTS: ReadonlyMap<string, PixelAdjustment> = new Map([
  pixelwise(sepiaBinding(), (params: SepiaParams) => planAdjustment("sepia", params.intensity)),
  pixelwise(brightnessContrastBinding(), brightnessContrastPlan),
  pixelwise(hueSaturationBinding(), hueSaturationPlan),
  pixelwise(posterizeBinding(), posterizePlan),
  pixelwise(levelsBinding(), levelsPlan),
  pixelwise(curvesBinding(), curvesPlan),
  pixelwise(exposureBinding(), exposurePlan),
  pixelwise(temperatureTintBinding(), temperatureTintPlan),
]);

/** The per-pixel adjustment of an effect id, or undefined when the effect is not one. */
export function pixelAdjustment(effectId: string): PixelAdjustment | undefined {
  return PIXEL_ADJUSTMENTS.get(effectId);
}
