import { describe, expect, it } from "vitest";
import {
  affineBounds,
  applyAffine,
  invertAffine,
  isIntegerTranslation,
  rotationAboutAffine,
  sameAffine,
  scalingAboutAffine,
  translationAffine,
} from "./affine";
import { rect } from "./geometry";
import { composeAffine } from "./selection-polygons";

function near(actual: { x: number; y: number }, x: number, y: number): void {
  expect(actual.x).toBeCloseTo(x, 9);
  expect(actual.y).toBeCloseTo(y, 9);
}

describe("affine helpers", () => {
  it("scales and rotates about the given point", () => {
    near(applyAffine(scalingAboutAffine(10, 10, 2, 3), 12, 11), 14, 13);
    near(applyAffine(rotationAboutAffine(5, 5, Math.PI / 2), 6, 5), 5, 6);
  });

  it("inverts a composed transform back to the original points", () => {
    const m = composeAffine(
      rotationAboutAffine(3, 4, 0.7),
      composeAffine(scalingAboutAffine(0, 0, 1.5, -0.5), translationAffine(2, -7)),
    );
    const back = invertAffine(m);
    near(applyAffine(back, ...pointOf(applyAffine(m, 4.25, -1.5))), 4.25, -1.5);
  });

  it("rejects a singular transform", () => {
    expect(() => invertAffine(scalingAboutAffine(0, 0, 0, 1))).toThrow(RangeError);
  });

  it("recognizes whole-pixel translations only", () => {
    expect(isIntegerTranslation(translationAffine(3, -2))).toBe(true);
    expect(isIntegerTranslation(translationAffine(0.5, 0))).toBe(false);
    expect(isIntegerTranslation(scalingAboutAffine(0, 0, 1, 2))).toBe(false);
  });

  it("compares matrices exactly", () => {
    expect(sameAffine(translationAffine(1, 2), translationAffine(1, 2))).toBe(true);
    expect(sameAffine(translationAffine(1, 2), translationAffine(1, 2.5))).toBe(false);
  });

  it("bounds a rotated rectangle by flooring the minimum and ceiling the maximum", () => {
    const bounds = affineBounds(rect(0, 0, 10, 10), rotationAboutAffine(0, 0, Math.PI / 4));
    expect(bounds.x).toBe(-8);
    expect(bounds.y).toBe(0);
    expect(bounds.width).toBe(16);
    expect(bounds.height).toBe(15);
  });
});

function pointOf(p: { x: number; y: number }): [number, number] {
  return [p.x, p.y];
}
