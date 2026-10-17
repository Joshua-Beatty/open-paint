import { LayerBlendMode, MemoryAccountant } from "@openpaint/document";
import { describe, expect, it, vi } from "vitest";
import {
  BENCH_ALPHA,
  BENCH_BLEND_MODES,
  benchLayerColor,
  createBenchDocument,
  installBenchHook,
} from "./bench-hook";

describe("benchLayerColor", () => {
  it("gives every layer its own color at about half alpha", () => {
    const colors = Array.from({ length: 20 }, (_, index) => benchLayerColor(index));
    const keys = new Set(colors.map(({ r, g, b }) => `${r},${g},${b}`));
    expect(keys.size).toBe(20);
    for (const color of colors) expect(color.a).toBe(BENCH_ALPHA);
  });
});

describe("createBenchDocument", () => {
  it("builds the layers through history, each filled and with a cycling blend mode", () => {
    const doc = createBenchDocument({ width: 300, height: 200, layers: 10, fill: true });
    expect(doc.layerCount).toBe(10);
    expect(doc.layers.map((layer) => layer.blendMode)).toEqual(
      Array.from({ length: 10 }, (_, index) => BENCH_BLEND_MODES[index % BENCH_BLEND_MODES.length]),
    );
    expect(doc.layers[1]?.blendMode).toBe(LayerBlendMode.multiply);
    doc.layers.forEach((layer, index) => {
      expect(layer.pixels.getPixel(299, 199)).toEqual(benchLayerColor(index));
    });
    expect(doc.history.entries.length).toBeGreaterThan(1);
    doc.dispose();
  });

  it("leaves the layers transparent without a fill", () => {
    const doc = createBenchDocument({ width: 64, height: 64, layers: 2, fill: false });
    expect(doc.layers[1]?.pixels.getPixel(0, 0).a).toBe(0);
    doc.dispose();
  });
});

describe("installBenchHook", () => {
  it("opens generated documents, sets the brush size and removes itself", () => {
    const target = { devicePixelRatio: 2 } as unknown as Window;
    const open = vi.fn();
    const setSetting = vi.fn();
    const remove = installBenchHook(target, {
      open,
      accountant: () => new MemoryAccountant(),
      setSetting,
      status: () => undefined,
      layout: () => undefined,
    });
    expect(
      target.__openpaintBench?.createDocument({ width: 8, height: 8, layers: 3, fill: true }),
    ).toEqual({ layers: 3 });
    expect(open).toHaveBeenCalledOnce();
    target.__openpaintBench?.setBrushSize(100);
    expect(setSetting).toHaveBeenCalledWith("tools.brush.size", 100);
    expect(target.__openpaintBench?.info().devicePixelRatio).toBe(2);
    remove();
    expect(target.__openpaintBench).toBeUndefined();
  });
});
