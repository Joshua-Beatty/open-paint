import { TILE_SIZE } from "@openpaint/document";
import { describe, expect, it } from "vitest";
import { createTestDocument } from "./test-document";

describe("createTestDocument", () => {
  it("generates a single layer of the requested size", () => {
    const doc = createTestDocument(300, 200);
    expect(doc.width).toBe(300);
    expect(doc.height).toBe(200);
    expect(doc.layers).toHaveLength(1);
    expect(doc.layers[0]?.store.tilesX).toBe(Math.ceil(300 / TILE_SIZE));
    expect(doc.layers[0]?.store.allocatedTileCount).toBe(2);
  });

  it("paints the color ramp, the checker, and a transparent ring", () => {
    const { store } = createTestDocument(300, 200).layers[0] ?? { store: undefined };
    expect(store?.getPixel(0, 0)).toEqual({ r: 0, g: 0, b: 255, a: 255 });
    expect(store?.getPixel(299, 0).r).toBe(255);
    expect(store?.getPixel(0, 199).g).toBe(255);
    expect(store?.getPixel(150, 100).a).toBe(255);
    expect(store?.getPixel(241, 100).a).toBe(0);
  });
});
