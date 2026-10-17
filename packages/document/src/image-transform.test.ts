import { describe, expect, it } from "vitest";
import type { Size } from "./geometry";
import {
  canvasOffset,
  flipMatrix,
  rotatedSize,
  rotationMatrix,
  scaledSize,
  sizeWithHeight,
  sizeWithWidth,
} from "./image-transform";
import { MAX_IMAGE_SIZE } from "./limits";
import type { AffineMatrix } from "./selection-polygons";

function apply(m: AffineMatrix, x: number, y: number): [number, number] {
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

describe("scaledSize (DOC-IMG-02 By percentage)", () => {
  it("rounds each side and keeps the sides within 1 to 262,144 px", () => {
    expect(scaledSize({ width: 9, height: 5 }, 50)).toEqual({ width: 5, height: 3 });
    expect(scaledSize({ width: 10, height: 10 }, 100)).toEqual({ width: 10, height: 10 });
    expect(scaledSize({ width: 10, height: 10 }, 0.01)).toEqual({ width: 1, height: 1 });
    expect(scaledSize({ width: 200_000, height: 10 }, 200)).toEqual({
      width: MAX_IMAGE_SIZE,
      height: 20,
    });
  });

  it("rejects percentages that are not positive numbers", () => {
    expect(() => scaledSize({ width: 4, height: 4 }, 0)).toThrow(RangeError);
    expect(() => scaledSize({ width: 4, height: 4 }, Number.NaN)).toThrow(RangeError);
  });
});

describe("sizeWithWidth and sizeWithHeight (DOC-IMG-02 aspect lock)", () => {
  const current: Size = { width: 200, height: 100 };

  it("follows the other side with the aspect lock on", () => {
    expect(sizeWithWidth(current, 50, true)).toEqual({ width: 50, height: 25 });
    expect(sizeWithHeight(current, 50, true)).toEqual({ width: 100, height: 50 });
  });

  it("changes only the given side with the lock off", () => {
    expect(sizeWithWidth(current, 50, false)).toEqual({ width: 50, height: 100 });
    expect(sizeWithHeight(current, 50, false)).toEqual({ width: 200, height: 50 });
  });

  it("keeps the derived side at least 1 px", () => {
    expect(sizeWithWidth(current, 0, true)).toEqual({ width: 1, height: 1 });
  });
});

describe("canvasOffset (DOC-IMG-03 anchor)", () => {
  const from: Size = { width: 8, height: 8 };

  it("places the old pixels by the anchor when the canvas grows", () => {
    const to: Size = { width: 10, height: 12 };
    expect(canvasOffset("topLeft", from, to)).toEqual({ x: 0, y: 0 });
    expect(canvasOffset("top", from, to)).toEqual({ x: 1, y: 0 });
    expect(canvasOffset("topRight", from, to)).toEqual({ x: 2, y: 0 });
    expect(canvasOffset("left", from, to)).toEqual({ x: 0, y: 2 });
    expect(canvasOffset("center", from, to)).toEqual({ x: 1, y: 2 });
    expect(canvasOffset("bottomLeft", from, to)).toEqual({ x: 0, y: 4 });
    expect(canvasOffset("bottom", from, to)).toEqual({ x: 1, y: 4 });
    expect(canvasOffset("bottomRight", from, to)).toEqual({ x: 2, y: 4 });
  });

  it("gives negative offsets when the canvas shrinks, rounding halves toward zero", () => {
    expect(canvasOffset("bottomRight", from, { width: 5, height: 5 })).toEqual({ x: -3, y: -3 });
    expect(canvasOffset("center", from, { width: 5, height: 5 })).toEqual({ x: -1, y: -1 });
    expect(canvasOffset("center", from, { width: 7, height: 8 })).toEqual({ x: 0, y: 0 });
  });
});

describe("rotatedSize", () => {
  it("swaps the sides for a quarter turn and keeps them for a half turn", () => {
    const size = { width: 6, height: 4 };
    expect(rotatedSize(size, "cw")).toEqual({ width: 4, height: 6 });
    expect(rotatedSize(size, "ccw")).toEqual({ width: 4, height: 6 });
    expect(rotatedSize(size, "half")).toEqual({ width: 6, height: 4 });
  });
});

describe("selection matrices for image transforms", () => {
  const size = { width: 10, height: 6 };

  it("mirror the corners of the canvas", () => {
    expect(apply(flipMatrix("horizontal", size), 0, 0)).toEqual([10, 0]);
    expect(apply(flipMatrix("vertical", size), 0, 0)).toEqual([0, 6]);
  });

  it("send the top-left corner to where a rotation puts it", () => {
    expect(apply(rotationMatrix("cw", size), 0, 0)).toEqual([6, 0]);
    expect(apply(rotationMatrix("cw", size), 10, 0)).toEqual([6, 10]);
    expect(apply(rotationMatrix("ccw", size), 0, 0)).toEqual([0, 10]);
    expect(apply(rotationMatrix("ccw", size), 10, 0)).toEqual([0, 0]);
    expect(apply(rotationMatrix("half", size), 0, 0)).toEqual([10, 6]);
  });
});
