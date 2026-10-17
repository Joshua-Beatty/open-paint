import type { RgbaImage } from "@openpaint/codecs";
import { describe, expect, it } from "vitest";
import { diffImages } from "./compare";

const image = (data: number[], width = 1, height = 1): RgbaImage => ({
  width,
  height,
  data: new Uint8Array(data),
});

describe("diffImages", () => {
  it("reports no difference for identical images", () => {
    expect(diffImages(image([1, 2, 3, 4]), image([1, 2, 3, 4]))).toEqual({
      maxDifference: 0,
      differingChannels: 0,
    });
  });

  it("reports the largest channel difference and how many channels differ", () => {
    expect(diffImages(image([10, 20, 30, 40]), image([11, 20, 27, 40]))).toEqual({
      maxDifference: 3,
      differingChannels: 2,
    });
  });

  it("refuses images of different sizes", () => {
    expect(() => diffImages(image([0, 0, 0, 0]), image([0, 0, 0, 0, 0, 0, 0, 0], 2, 1))).toThrow(
      "reference is 2x1",
    );
  });
});
