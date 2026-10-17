import { Surface } from "@openpaint/document";
import { describe, expect, it } from "vitest";
import { EXIF_TAG_ORIENTATION, exifOrientation } from "./exif";
import { applyExifOrientation, orientSurface } from "./orientation";
import { tiffWithShorts } from "./test-fixtures";

/** A 2 wide, 3 high surface whose red channel holds the pixel's index (row-major). */
function numbered(): Surface {
  const surface = new Surface(2, 3);
  for (let index = 0; index < 6; index += 1) {
    surface.data[index * 4] = index;
    surface.data[index * 4 + 3] = 255;
  }
  return surface;
}

/** The red channels of a surface, row by row. */
function redOf(surface: Surface): number[] {
  const reds: number[] = [];
  for (let index = 0; index < surface.width * surface.height; index += 1) {
    reds.push(surface.data[index * 4] ?? -1);
  }
  return reds;
}

describe("orientSurface", () => {
  it("keeps the pixels for orientation 1", () => {
    expect(redOf(orientSurface(numbered(), 1))).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("mirrors and turns the pixels as the tag asks", () => {
    const cases: [orientation: number, width: number, height: number, reds: number[]][] = [
      [2, 2, 3, [1, 0, 3, 2, 5, 4]],
      [3, 2, 3, [5, 4, 3, 2, 1, 0]],
      [4, 2, 3, [4, 5, 2, 3, 0, 1]],
      [5, 3, 2, [0, 2, 4, 1, 3, 5]],
      [6, 3, 2, [4, 2, 0, 5, 3, 1]],
      [7, 3, 2, [5, 3, 1, 4, 2, 0]],
      [8, 3, 2, [1, 3, 5, 0, 2, 4]],
    ];
    for (const [orientation, width, height, reds] of cases) {
      const turned = orientSurface(numbered(), orientation);
      expect([turned.width, turned.height], `orientation ${orientation}`).toEqual([width, height]);
      expect(redOf(turned), `orientation ${orientation}`).toEqual(reds);
    }
  });
});

describe("applyExifOrientation", () => {
  it("turns the image and removes the tag when it is not normal", () => {
    const exif = tiffWithShorts([[EXIF_TAG_ORIENTATION, 6]]);
    const upright = applyExifOrientation(numbered(), exif);
    expect([upright.surface.width, upright.surface.height]).toEqual([3, 2]);
    expect(exifOrientation(upright.exif)).toBeUndefined();
  });

  it("changes nothing for a normal or absent orientation", () => {
    const surface = numbered();
    const normal = tiffWithShorts([[EXIF_TAG_ORIENTATION, 1]]);
    expect(applyExifOrientation(surface, normal)).toEqual({ surface, exif: normal });
    expect(applyExifOrientation(surface, undefined)).toEqual({ surface, exif: undefined });
  });
});
