import { afterEach, describe, expect, it } from "vitest";
import {
  clampDialogOffset,
  forgetDialogOffsets,
  isDialogOffsetReachable,
  rememberDialogOffset,
  rememberedDialogOffset,
} from "./dialog-drag";

afterEach(() => forgetDialogOffsets());

const viewport = { width: 1000, height: 800 };
/** A 300 px wide dialog centred in the viewport, with a 40 px title bar. */
const bar = { left: 350, top: 200, right: 650, bottom: 240 };

describe("clampDialogOffset", () => {
  it("leaves an offset that keeps the title bar on screen", () => {
    expect(clampDialogOffset({ x: -300, y: 100 }, bar, viewport)).toEqual({ x: -300, y: 100 });
    expect(clampDialogOffset({ x: 0, y: 0 }, bar, viewport)).toEqual({ x: 0, y: 0 });
  });

  it("keeps 96 px of the title bar inside the left and right edges", () => {
    // The bar's right edge stops 96 px from the left of the viewport.
    expect(clampDialogOffset({ x: -5000, y: 0 }, bar, viewport).x).toBe(96 - 650);
    // Its left edge stops 96 px from the right.
    expect(clampDialogOffset({ x: 5000, y: 0 }, bar, viewport).x).toBe(1000 - 96 - 350);
    expect(clampDialogOffset({ x: -5000, y: 0 }, bar, viewport, 48).x).toBe(48 - 650);
  });

  it("keeps the whole title bar inside the top and bottom edges", () => {
    expect(clampDialogOffset({ x: 0, y: -5000 }, bar, viewport).y).toBe(-200);
    expect(clampDialogOffset({ x: 0, y: 5000 }, bar, viewport).y).toBe(800 - 240);
  });

  it("keeps the top edge on screen when the bar is taller than the viewport", () => {
    const tall = { left: 0, top: -50, right: 300, bottom: 950 };
    expect(clampDialogOffset({ x: 0, y: 100 }, tall, viewport).y).toBe(50);
    expect(clampDialogOffset({ x: 0, y: -100 }, tall, viewport).y).toBe(50);
  });

  it("keeps all of a bar narrower than the minimum on screen", () => {
    const narrow = { left: 480, top: 0, right: 500, bottom: 20 };
    // 20 px wide, narrower than the 96 px minimum.
    expect(clampDialogOffset({ x: -5000, y: 0 }, narrow, viewport).x).toBe(-480);
    expect(clampDialogOffset({ x: 5000, y: 0 }, narrow, viewport).x).toBe(1000 - 500);
  });

  it("tells whether an offset is reachable without clamping", () => {
    expect(isDialogOffsetReachable({ x: -300, y: 100 }, bar, viewport)).toBe(true);
    expect(isDialogOffsetReachable({ x: -700, y: 0 }, bar, viewport)).toBe(false);
    expect(isDialogOffsetReachable({ x: 0, y: 600 }, bar, viewport)).toBe(false);
  });
});

describe("remembered dialog positions", () => {
  it("are kept per dialog, and a centred dialog forgets its place", () => {
    rememberDialogOffset("Gaussian Blur", { x: -300, y: 100 });
    rememberDialogOffset("Levels", { x: 20, y: 0 });
    expect(rememberedDialogOffset("Gaussian Blur")).toEqual({ x: -300, y: 100 });
    expect(rememberedDialogOffset("Levels")).toEqual({ x: 20, y: 0 });
    rememberDialogOffset("Gaussian Blur", { x: 0, y: 0 });
    expect(rememberedDialogOffset("Gaussian Blur")).toBeUndefined();
  });
});
