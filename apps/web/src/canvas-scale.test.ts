import { afterEach, describe, expect, it, vi } from "vitest";
import { canvasScale, measuredScale } from "./canvas-scale";
import { devicePixelSize } from "./useEngine";

afterEach(() => canvasScale.reset());

describe("measuredScale", () => {
  it("is the canvas's device pixels per CSS pixel, whatever devicePixelRatio says", () => {
    expect(measuredScale({ width: 1792, height: 1086 }, { width: 896, height: 543 }, 1)).toBe(2);
    expect(measuredScale({ width: 896, height: 543 }, { width: 896, height: 543 }, 2)).toBe(1);
    expect(measuredScale({ width: 1120, height: 679 }, { width: 896, height: 543 }, 1)).toBe(1.25);
    expect(measuredScale({ width: 0, height: 0 }, { width: 0, height: 0 }, 1.5)).toBe(1.5);
  });
});

describe("devicePixelSize", () => {
  it("takes the scale from the device-pixel box", () => {
    const entry = {
      devicePixelContentBoxSize: [{ inlineSize: 1344, blockSize: 815 }],
      contentRect: { width: 896, height: 543.33 },
    } as unknown as ResizeObserverEntry;
    expect(devicePixelSize(entry)).toEqual({ width: 1344, height: 815, scale: 1.5 });
  });
});

describe("canvasScale", () => {
  it("tells its listeners when the measured scale changes", () => {
    const listener = vi.fn();
    const unsubscribe = canvasScale.subscribe(listener);
    canvasScale.set(2);
    canvasScale.set(2);
    expect(listener).toHaveBeenCalledOnce();
    expect(canvasScale.value).toBe(2);
    unsubscribe();
  });
});
