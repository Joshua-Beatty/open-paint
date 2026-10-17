import type { Surface } from "@openpaint/document";
import {
  type AdjustmentPlan,
  adjustmentCpu,
  autoLevelCpu,
  autoLevelPlan,
  brightnessContrastCpu,
  brightnessContrastPlan,
  CURVE_IDENTITY,
  type CurvesParams,
  curvesCpu,
  curvesPlan,
  exposureCpu,
  exposurePlan,
  HIGHLIGHTS_SHADOWS_DEFAULT_RADIUS,
  highlightsShadowsCpu,
  highlightsShadowsPlan,
  hueSaturationCpu,
  hueSaturationPlan,
  LEVELS_IDENTITY,
  levelsCpu,
  levelsPlan,
  planAdjustment,
  posterizeCpu,
  posterizePlan,
  SEPIA_DEFAULT_INTENSITY,
  temperatureTintCpu,
  temperatureTintPlan,
} from "@openpaint/effects";
import type { AdjustmentCase } from "./cases";

/** The Rust reference output of one adjustment case. Requires the WASM kernels to be initialized. */
export function adjustmentReference(kase: AdjustmentCase, input: Surface): Surface {
  switch (kase.adjustment) {
    case "autoLevel":
      return autoLevelCpu(input);
    case "levels":
      return levelsCpu(input, kase.levelsParams ?? LEVELS_IDENTITY);
    case "brightnessContrast":
      return brightnessContrastCpu(input, {
        brightness: kase.brightness ?? 0,
        contrast: kase.contrast ?? 0,
      });
    case "hueSaturation":
      return hueSaturationCpu(input, hueSaturationOf(kase));
    case "posterize":
      return posterizeCpu(input, { levels: kase.levels ?? [] });
    case "curves":
      return curvesCpu(input, curvesOf(kase));
    case "exposure":
      return exposureCpu(input, { exposure: kase.exposure ?? 0 });
    case "temperatureTint":
      return temperatureTintCpu(input, temperatureTintOf(kase));
    case "highlightsShadows":
      return highlightsShadowsCpu(input, highlightsShadowsOf(kase));
    default:
      return adjustmentCpu(kase.adjustment, input, kase.intensity ?? SEPIA_DEFAULT_INTENSITY);
  }
}

/** The WGSL plan of one adjustment case, the same numbers the Rust reference uses. */
export function adjustmentPlanFor(kase: AdjustmentCase, input: Surface): AdjustmentPlan {
  switch (kase.adjustment) {
    case "autoLevel":
      return autoLevelPlan(input);
    case "levels":
      return levelsPlan(kase.levelsParams ?? LEVELS_IDENTITY);
    case "brightnessContrast":
      return brightnessContrastPlan({
        brightness: kase.brightness ?? 0,
        contrast: kase.contrast ?? 0,
      });
    case "hueSaturation":
      return hueSaturationPlan(hueSaturationOf(kase));
    case "posterize":
      return posterizePlan({ levels: kase.levels ?? [] });
    case "curves":
      return curvesPlan(curvesOf(kase));
    case "exposure":
      return exposurePlan({ exposure: kase.exposure ?? 0 });
    case "temperatureTint":
      return temperatureTintPlan(temperatureTintOf(kase));
    case "highlightsShadows":
      return highlightsShadowsPlan(highlightsShadowsOf(kase));
    default:
      return planAdjustment(kase.adjustment, kase.intensity ?? SEPIA_DEFAULT_INTENSITY);
  }
}

function curvesOf(kase: AdjustmentCase): CurvesParams {
  return {
    mode: kase.curves?.mode ?? "luminosity",
    luminosity: kase.curves?.luminosity ?? CURVE_IDENTITY,
    red: kase.curves?.red ?? CURVE_IDENTITY,
    green: kase.curves?.green ?? CURVE_IDENTITY,
    blue: kase.curves?.blue ?? CURVE_IDENTITY,
  };
}

function temperatureTintOf(kase: AdjustmentCase) {
  return { temperature: kase.temperature ?? 0, tint: kase.tint ?? 0 };
}

function highlightsShadowsOf(kase: AdjustmentCase) {
  return {
    highlights: kase.highlights ?? 0,
    shadows: kase.shadows ?? 0,
    clarity: kase.clarity ?? 0,
    radius: kase.radius ?? HIGHLIGHTS_SHADOWS_DEFAULT_RADIUS,
  };
}

function hueSaturationOf(kase: AdjustmentCase) {
  return {
    hue: kase.hue ?? 0,
    saturation: kase.saturation ?? 100,
    lightness: kase.lightness ?? 0,
  };
}
