import { rect, TiledPixelStore } from "@openpaint/document";
import { describe, expect, it } from "vitest";
import { activeLayers, type CompositeDocument, tilesCovering, visibleRegion } from "./composite";

function doc(layers: CompositeDocument["layers"], width = 300, height = 200): CompositeDocument {
  return { width, height, layers };
}

describe("activeLayers", () => {
  it("keeps visible layers with opacity above zero, bottom to top", () => {
    const a = new TiledPixelStore(300, 200);
    const b = new TiledPixelStore(300, 200);
    const c = new TiledPixelStore(300, 200);
    const d = new TiledPixelStore(300, 200);
    const active = activeLayers(
      doc([
        { store: a, mode: 0, opacity: 255, visible: true },
        { store: b, mode: 1, opacity: 0, visible: true },
        { store: c, mode: 2, opacity: 128, visible: false },
        { store: d, mode: 13, opacity: 1, visible: true },
      ]),
    );
    expect(active.map((layer) => layer.store)).toEqual([a, d]);
  });

  it("rejects blend modes outside DOC-BLD-01", () => {
    const store = new TiledPixelStore(300, 200);
    expect(() => activeLayers(doc([{ store, mode: 14, opacity: 255, visible: true }]))).toThrow(
      "Unknown layer blend mode 14",
    );
    expect(() => activeLayers(doc([{ store, mode: 0.5, opacity: 255, visible: true }]))).toThrow(
      "Unknown layer blend mode 0.5",
    );
  });

  it("rejects opacity outside the integer range 0-255", () => {
    const store = new TiledPixelStore(300, 200);
    for (const opacity of [-1, 256, 12.5]) {
      expect(() => activeLayers(doc([{ store, mode: 0, opacity, visible: true }]))).toThrow(
        "not an integer in 0-255",
      );
    }
  });

  it("rejects layers that do not match the document size", () => {
    const store = new TiledPixelStore(300, 199);
    expect(() => activeLayers(doc([{ store, mode: 0, opacity: 255, visible: true }]))).toThrow(
      "Layer is 300x199",
    );
  });
});

describe("visibleRegion", () => {
  it("shows the top-left part of the document that fits the canvas", () => {
    expect(visibleRegion(doc([], 300, 200), 800, 600)).toEqual(rect(0, 0, 300, 200));
    expect(visibleRegion(doc([], 300, 200), 120, 80)).toEqual(rect(0, 0, 120, 80));
  });

  it("is empty for an empty document or canvas", () => {
    expect(visibleRegion(doc([], 0, 0), 800, 600).width).toBe(0);
    expect(visibleRegion(doc([], 300, 200), 0, 600).width).toBe(0);
  });
});

describe("tilesCovering", () => {
  it("lists the 256-pixel tiles a region touches, row-major", () => {
    expect(tilesCovering(rect(0, 0, 300, 200))).toEqual([
      { tx: 0, ty: 0 },
      { tx: 1, ty: 0 },
    ]);
    expect(tilesCovering(rect(255, 255, 2, 2))).toEqual([
      { tx: 0, ty: 0 },
      { tx: 1, ty: 0 },
      { tx: 0, ty: 1 },
      { tx: 1, ty: 1 },
    ]);
  });

  it("is empty for an empty region", () => {
    expect(tilesCovering(rect(0, 0, 0, 10))).toEqual([]);
  });
});
