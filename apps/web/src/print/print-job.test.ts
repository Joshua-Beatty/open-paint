import { describe, expect, it } from "vitest";
import { printLayout } from "./print-job";

describe("printLayout (FMT-PRN-01)", () => {
  it("fits the image to the page", () => {
    expect(
      printLayout({ width: 300, height: 200 }, { unit: "inch", x: 300, y: 300 }, "fit"),
    ).toEqual({ mode: "fit", width: "100%", height: "100%" });
  });

  it("sizes the image in inches from the resolution, per axis", () => {
    expect(
      printLayout({ width: 300, height: 150 }, { unit: "inch", x: 300, y: 150 }, "actual"),
    ).toEqual({ mode: "actual", width: "1in", height: "1in" });
  });

  it("converts a centimeter resolution to inches", () => {
    const layout = printLayout(
      { width: 118.11, height: 59.06 },
      { unit: "centimeter", x: 10, y: 10 },
      "actual",
    );
    expect(layout.mode).toBe("actual");
    expect(Number.parseFloat(layout.width)).toBeCloseTo(118.11 / 25.4, 6);
    expect(Number.parseFloat(layout.height)).toBeCloseTo(59.06 / 25.4, 6);
  });

  it("uses the screen's 96 per inch for a pixel resolution, as CSS does", () => {
    expect(
      printLayout({ width: 96, height: 192 }, { unit: "pixel", x: 1, y: 1 }, "actual"),
    ).toEqual({ mode: "actual", width: "1in", height: "2in" });
  });
});
