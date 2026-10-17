import { describe, expect, it } from "vitest";
import { EXIF_TAG_ORIENTATION, exifOrientation, removeExifTag } from "./exif";
import { tiffWithShorts } from "./test-fixtures";

/** The tags of IFD0, in order. */
function tagsOf(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(8, true);
  return Array.from({ length: count }, (_, index) => view.getUint16(10 + index * 12, true));
}

describe("exifOrientation", () => {
  it("reads the Orientation SHORT of IFD0", () => {
    expect(exifOrientation(tiffWithShorts([[0x0112, 6]]))).toBe(6);
  });

  it("is undefined when the tag is absent or the block is malformed", () => {
    expect(exifOrientation(undefined)).toBeUndefined();
    expect(exifOrientation(tiffWithShorts([[0x0128, 2]]))).toBeUndefined();
    expect(exifOrientation(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });
});

describe("removeExifTag", () => {
  it("removes the Orientation entry and keeps the others in order", () => {
    const before = tiffWithShorts([
      [0x0128, 2],
      [0x0112, 6],
      [0x0131, 9],
    ]);
    const after = removeExifTag(before, EXIF_TAG_ORIENTATION);
    expect(exifOrientation(after)).toBeUndefined();
    expect(tagsOf(after)).toEqual([0x0128, 0x0131]);
    expect(after.length).toBe(before.length);
  });

  it("leaves the block untouched when the tag is absent", () => {
    const block = tiffWithShorts([[0x0128, 2]]);
    expect(removeExifTag(block, EXIF_TAG_ORIENTATION)).toEqual(block);
  });
});
