import { describe, expect, it } from "vitest";
import { thumbnailBox } from "./thumbnail-box";

const MAX = { width: 40, height: 26 };

describe("thumbnailBox (UI-FTW-05, UI-TABS-01)", () => {
  it("keeps the image's aspect ratio inside the box, touching it on one side", () => {
    expect(thumbnailBox({ width: 800, height: 600 }, MAX)).toEqual({ width: 35, height: 26 });
    expect(thumbnailBox({ width: 1920, height: 1080 }, MAX)).toEqual({ width: 40, height: 23 });
    expect(thumbnailBox({ width: 100, height: 400 }, MAX)).toEqual({ width: 7, height: 26 });
  });

  it("scales a small image up to the box, since the box is the display size", () => {
    expect(thumbnailBox({ width: 4, height: 4 }, MAX)).toEqual({ width: 26, height: 26 });
  });

  it("keeps at least one pixel across for a very thin image", () => {
    expect(thumbnailBox({ width: 10_000, height: 1 }, MAX)).toEqual({ width: 40, height: 1 });
  });

  it("fills the box for an image with no area", () => {
    expect(thumbnailBox({ width: 0, height: 0 }, MAX)).toEqual(MAX);
  });
});
