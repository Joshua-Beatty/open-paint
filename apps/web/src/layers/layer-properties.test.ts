import { LayerBlendMode, type LayerProperties } from "@openpaint/document";
import { describe, expect, it } from "vitest";
import {
  BLEND_MODE_MESSAGES,
  LAYER_BLEND_MODE_ORDER,
  layerDraft,
  layerPropertyPatch,
} from "./layer-properties";

const properties: LayerProperties = {
  name: "Layer 2",
  visible: true,
  opacity: 255,
  blendMode: LayerBlendMode.normal,
};

describe("LAYER_BLEND_MODE_ORDER", () => {
  it("lists every layer blend mode once, Normal first (DOC-BLD-01)", () => {
    expect(LAYER_BLEND_MODE_ORDER).toHaveLength(14);
    expect(new Set(LAYER_BLEND_MODE_ORDER).size).toBe(14);
    expect(LAYER_BLEND_MODE_ORDER[0]).toBe(LayerBlendMode.normal);
    expect(LAYER_BLEND_MODE_ORDER[13]).toBe(LayerBlendMode.xor);
  });

  it("has a label key for every mode", () => {
    for (const mode of LAYER_BLEND_MODE_ORDER) {
      expect(BLEND_MODE_MESSAGES[mode]).toMatch(/^blend\./);
    }
  });
});

describe("layerPropertyPatch", () => {
  it("returns nothing when the draft matches the layer", () => {
    expect(layerPropertyPatch(properties, layerDraft(properties))).toEqual({});
  });

  it("returns only the changed properties", () => {
    const patch = layerPropertyPatch(properties, {
      ...layerDraft(properties),
      opacity: 128,
      visible: false,
    });
    expect(patch).toEqual({ opacity: 128, visible: false });
  });

  it("truncates a long name and rounds and clamps the opacity", () => {
    const current = { ...properties, opacity: 100 };
    const patch = layerPropertyPatch(current, {
      ...layerDraft(current),
      name: "n".repeat(300),
      opacity: 300.4,
      blendMode: LayerBlendMode.screen,
    });
    expect(patch.name).toBe("n".repeat(256));
    expect(patch.opacity).toBe(255);
    expect(patch.blendMode).toBe(LayerBlendMode.screen);
    expect(layerPropertyPatch(current, { ...layerDraft(current), opacity: -4 })).toEqual({
      opacity: 0,
    });
  });
});
