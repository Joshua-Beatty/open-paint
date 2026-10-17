import { describe, expect, it } from "vitest";
import { canvasTheme, DEFAULT_CANVAS_THEME, frameStyle } from "./frame";

describe("canvas style theme (SET-DLG-04)", () => {
  it("keeps the default chrome when every setting is at its factory value", () => {
    const theme = canvasTheme({ dropShadow: true, checkerboardBrightness: 1, borderColor: null });
    expect(theme).toEqual({ ...DEFAULT_CANVAS_THEME, checkerBrightness: 1 });
  });

  it("removes the drop shadow when it is turned off", () => {
    const theme = canvasTheme({ dropShadow: false, checkerboardBrightness: 1, borderColor: null });
    expect(theme.shadow.alpha).toBe(0);
    expect(frameStyle(theme, 1).shadow.alpha).toBe(0);
  });

  it("scales the checkerboard by its brightness", () => {
    const style = frameStyle(
      canvasTheme({ dropShadow: true, checkerboardBrightness: 0.5, borderColor: null }),
      1,
    );
    expect(style.checker.light).toBeCloseTo(127.5);
    expect(style.checker.dark).toBeCloseTo(95.5);
  });

  it("draws a custom border only when one is given", () => {
    const bordered = canvasTheme({
      dropShadow: true,
      checkerboardBrightness: 1,
      borderColor: [128, 0, 255],
    });
    expect(frameStyle(bordered, 1).border).toEqual([128, 0, 255]);
    const plain = canvasTheme({ dropShadow: true, checkerboardBrightness: 1, borderColor: null });
    expect(frameStyle(plain, 1).border).toBeUndefined();
  });
});
