import type { ChoiceOption, ChoiceProperty } from "@openpaint/properties";

/**
 * The render blend modes (FX-SHARED-MIXMODE), in the spec's order. The index is the code that the
 * Rust `MixMode` takes, so the list must not be reordered.
 */
export const MIX_MODE_KEYS = [
  "over",
  "under",
  "overwrite",
  "multiply",
  "screen",
  "darken",
  "lighten",
  "dissolve",
  "colorBurn",
  "linearBurn",
  "darkerColor",
  "lighterColor",
  "colorDodge",
  "linearDodge",
  "overlay",
  "softLight",
  "hardLight",
  "vividLight",
  "linearLight",
  "pinLight",
  "hardMix",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
  "subtract",
  "division",
  "additive",
  "reflect",
  "glow",
  "negation",
  "min",
  "max",
  "in",
  "destinationIn",
  "out",
  "destinationOut",
  "atop",
  "destinationAtop",
  "plus",
  "maskInvert",
  "xor8",
  "xor16",
  "xorComposite",
] as const;

export type MixModeKey = (typeof MIX_MODE_KEYS)[number];

/** The number of render blend modes, 46 (FX-SHARED-MIXMODE). */
export const MIX_MODE_COUNT = MIX_MODE_KEYS.length;

/** The code of Over (Normal), the default blend mode of Clouds and Turbulence. */
export const MIX_MODE_OVER = 0;

/** The code of Overwrite, the default blend mode of Julia and Mandelbrot (FX-RENDER-JULIA-01). */
export const MIX_MODE_OVERWRITE = 2;

/** The drop-down items, valued by code and labelled through the catalog (FX-SHARED-MIXMODE). */
export function mixModeOptions(): ChoiceOption[] {
  return MIX_MODE_KEYS.map((key, code) => ({ value: code, label: `mix.${key}` as const }));
}

/** The "Blend Mode:" drop-down (FX-SHARED-MIXMODE): captioned by its description, with no heading. */
export function mixModeProperty(defaultCode: number = MIX_MODE_OVER): ChoiceProperty {
  return {
    kind: "choice",
    key: "blendMode",
    label: "property.noCaption",
    defaultValue: defaultCode,
    options: mixModeOptions(),
    control: { description: "property.blendMode" },
  };
}
