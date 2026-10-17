import { describe, expect, it } from "vitest";
import { LayerBlendMode } from "./blend-mode";
import { Layer, MAX_LAYER_NAME_LENGTH, normalizeLayerProperties, truncateLayerName } from "./layer";
import { TiledPixelStore } from "./tiled-store";

const base = { name: "Layer 1", visible: true, opacity: 255, blendMode: LayerBlendMode.normal };

function makeLayer(overrides: Partial<typeof base> = {}): Layer {
  return new Layer(1, new TiledPixelStore(4, 4), { ...base, ...overrides });
}

describe("layer names (DOC-LYR-01)", () => {
  it("truncates names to 256 characters on input", () => {
    const long = "a".repeat(300);
    expect(truncateLayerName(long)).toHaveLength(MAX_LAYER_NAME_LENGTH);
    expect(makeLayer({ name: long }).name).toHaveLength(256);
  });

  it("counts characters, not UTF-16 units", () => {
    const emoji = "😀".repeat(257);
    expect(Array.from(truncateLayerName(emoji))).toHaveLength(256);
  });

  it("keeps short names unchanged", () => {
    expect(truncateLayerName("Sky")).toBe("Sky");
  });
});

describe("layer property validation", () => {
  it("accepts opacity from 0 to 255 only as integers", () => {
    expect(normalizeLayerProperties({ opacity: 0 }).opacity).toBe(0);
    expect(normalizeLayerProperties({ opacity: 255 }).opacity).toBe(255);
    expect(() => normalizeLayerProperties({ opacity: 256 })).toThrow(RangeError);
    expect(() => normalizeLayerProperties({ opacity: -1 })).toThrow(RangeError);
    expect(() => normalizeLayerProperties({ opacity: 12.5 })).toThrow(RangeError);
  });

  it("rejects unknown blend modes and non-boolean visibility", () => {
    expect(() => normalizeLayerProperties({ blendMode: 14 as LayerBlendMode })).toThrow(RangeError);
    expect(() => normalizeLayerProperties({ visible: 1 as unknown as boolean })).toThrow(TypeError);
  });

  it("reports whether applying properties changed anything", () => {
    const layer = makeLayer();
    expect(layer.applyProperties({ opacity: 255, visible: true })).toBe(false);
    expect(layer.applyProperties({ opacity: 128 })).toBe(true);
    expect(layer.opacity).toBe(128);
  });

  it("swaps in same-sized pixels and returns the previous store", () => {
    const layer = makeLayer();
    const previous = layer.pixels;
    const next = new TiledPixelStore(4, 4);
    expect(layer.replacePixels(next)).toBe(previous);
    expect(layer.pixels).toBe(next);
    expect(() => layer.replacePixels(new TiledPixelStore(5, 4))).toThrow(RangeError);
  });

  it("marks only the background layer as IsBackground", () => {
    expect(makeLayer().isBackground).toBe(false);
    const background = new Layer(2, new TiledPixelStore(4, 4), { ...base, isBackground: true });
    expect(background.isBackground).toBe(true);
  });
});
