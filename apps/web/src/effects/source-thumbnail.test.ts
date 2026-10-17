import { type ResampleRunner, Surface } from "@openpaint/document";
import { describe, expect, it } from "vitest";
import { sourceThumbnailSize, sourceThumbnailUrl } from "./source-thumbnail";

describe("sourceThumbnailSize", () => {
  it("keeps a small source at its size", () => {
    expect(sourceThumbnailSize(40, 24)).toEqual({ width: 40, height: 24 });
  });

  it("scales the longer side to the thumbnail size and keeps the aspect ratio", () => {
    expect(sourceThumbnailSize(1024, 512)).toEqual({ width: 256, height: 128 });
    expect(sourceThumbnailSize(300, 1200)).toEqual({ width: 64, height: 256 });
  });

  it("never goes below one pixel on either side", () => {
    expect(sourceThumbnailSize(4000, 1)).toEqual({ width: 256, height: 1 });
  });
});

describe("sourceThumbnailUrl", () => {
  it("has no thumbnail when the effect has no source", async () => {
    await expect(sourceThumbnailUrl(undefined)).resolves.toBeUndefined();
  });

  it("resamples the source to the thumbnail size on the given runner (PRD-NF-02)", async () => {
    const sizes: [number, number][] = [];
    const resample: ResampleRunner = async (_source, width, height) => {
      sizes.push([width, height]);
      return new Surface(width, height);
    };
    const source = { pixels: new Surface(1024, 512), coverage: undefined };
    await sourceThumbnailUrl(source, resample);
    expect(sizes).toEqual([[256, 128]]);
  });
});
