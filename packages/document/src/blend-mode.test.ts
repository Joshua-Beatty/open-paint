import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAYER_BLEND_MODE,
  isLayerBlendMode,
  LAYER_BLEND_MODE_COUNT,
  LayerBlendMode,
} from "./blend-mode";

describe("layer blend modes (DOC-BLD-01)", () => {
  it("uses the reference values 0 (Normal) through 13 (Xor) in UI order", () => {
    expect(Object.values(LayerBlendMode)).toEqual(Array.from({ length: 14 }, (_, i) => i));
    expect(LayerBlendMode.normal).toBe(0);
    expect(LayerBlendMode.multiply).toBe(1);
    expect(LayerBlendMode.screen).toBe(12);
    expect(LayerBlendMode.xor).toBe(13);
    expect(LAYER_BLEND_MODE_COUNT).toBe(14);
  });

  it("defaults new layers to Normal", () => {
    expect(DEFAULT_LAYER_BLEND_MODE).toBe(LayerBlendMode.normal);
  });

  it("accepts only whole numbers in range", () => {
    expect(isLayerBlendMode(0)).toBe(true);
    expect(isLayerBlendMode(13)).toBe(true);
    expect(isLayerBlendMode(14)).toBe(false);
    expect(isLayerBlendMode(-1)).toBe(false);
    expect(isLayerBlendMode(1.5)).toBe(false);
    expect(isLayerBlendMode("1")).toBe(false);
    expect(isLayerBlendMode(undefined)).toBe(false);
  });
});
