import { PropertyCollection } from "@openpaint/properties";
import { describe, expect, it } from "vitest";
import { PNG_SAVE_SCHEMA, pngIsLossless, pngSaveOptions } from "./png-options";

describe("PNG save options (FMT-OPT-PNG-01)", () => {
  it("starts from the spec defaults", () => {
    expect(pngSaveOptions({})).toEqual({
      bitDepth: 0,
      quantization: "octree",
      dithering: 7,
      transparencyThreshold: 128,
      interlaced: false,
      removeMetadata: false,
    });
  });

  it("keeps the spec's bit-depth order and labels for the radio group", () => {
    const bitDepth = PNG_SAVE_SCHEMA.properties.find((property) => property.key === "bitDepth");
    expect(bitDepth?.kind === "choice" && bitDepth.options.map((option) => option.value)).toEqual([
      0, 32, 24, 8, 4, 2, 1,
    ]);
  });

  it("enables quantization and dithering only for the indexed depths", () => {
    const collection = new PropertyCollection(PNG_SAVE_SCHEMA, {});
    expect(collection.isReadOnly("quantization")).toBe(true);
    expect(collection.isReadOnly("dithering")).toBe(true);
    for (const depth of [8, 4, 2, 1]) {
      collection.set("bitDepth", depth);
      expect(collection.isReadOnly("quantization")).toBe(false);
      expect(collection.isReadOnly("dithering")).toBe(false);
    }
    collection.set("bitDepth", 24);
    expect(collection.isReadOnly("dithering")).toBe(true);
  });

  it("enables the transparency threshold only for 8-bit", () => {
    const collection = new PropertyCollection(PNG_SAVE_SCHEMA, { bitDepth: 4 });
    expect(collection.isReadOnly("transparencyThreshold")).toBe(true);
    collection.set("bitDepth", 8);
    expect(collection.isReadOnly("transparencyThreshold")).toBe(false);
  });

  it("puts Remove metadata last, as every flat format does", () => {
    const keys = PNG_SAVE_SCHEMA.properties.map((property) => property.key);
    expect(keys.at(-1)).toBe("removeMetadata");
  });

  it("reports only Auto-detect and 32-bit as lossless", () => {
    expect(pngIsLossless({ bitDepth: 0 })).toBe(true);
    expect(pngIsLossless({ bitDepth: 32 })).toBe(true);
    for (const bitDepth of [24, 8, 4, 2, 1]) expect(pngIsLossless({ bitDepth })).toBe(false);
  });

  it("falls back to the defaults for invalid stored values", () => {
    expect(pngSaveOptions({ bitDepth: 7, dithering: 99, quantization: "nope" })).toMatchObject({
      bitDepth: 0,
      dithering: 8,
      quantization: "octree",
    });
  });
});
