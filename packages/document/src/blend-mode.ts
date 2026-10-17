/**
 * DOC-BLD-01 layer blend modes. The values match the Rust reference (`blend.rs`) and the WGSL
 * compositor, so they are stored and passed to the kernels unchanged.
 */
export const LayerBlendMode = {
  normal: 0,
  multiply: 1,
  additive: 2,
  colorBurn: 3,
  colorDodge: 4,
  reflect: 5,
  glow: 6,
  overlay: 7,
  difference: 8,
  negation: 9,
  lighten: 10,
  darken: 11,
  screen: 12,
  xor: 13,
} as const;

export type LayerBlendMode = (typeof LayerBlendMode)[keyof typeof LayerBlendMode];

export const LAYER_BLEND_MODE_COUNT = 14;
export const DEFAULT_LAYER_BLEND_MODE: LayerBlendMode = LayerBlendMode.normal;

export function isLayerBlendMode(value: unknown): value is LayerBlendMode {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < LAYER_BLEND_MODE_COUNT
  );
}
