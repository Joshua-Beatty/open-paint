import { describe, expect, it } from "vitest";
import { BRUSH_SIZE_PRESETS, CORNER_SIZE_PRESETS } from "./size-presets";

describe("BRUSH_SIZE_PRESETS (TL-OPT-BRUSH)", () => {
  it("runs 1 to 15, then by 5 to 100, by 25 to 500, by 50 to 1000 and by 100 to 2000", () => {
    expect(BRUSH_SIZE_PRESETS.slice(0, 15)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(BRUSH_SIZE_PRESETS).toContain(20);
    expect(BRUSH_SIZE_PRESETS).toContain(100);
    expect(BRUSH_SIZE_PRESETS).not.toContain(105);
    expect(BRUSH_SIZE_PRESETS).toContain(125);
    expect(BRUSH_SIZE_PRESETS).toContain(500);
    expect(BRUSH_SIZE_PRESETS).not.toContain(525);
    expect(BRUSH_SIZE_PRESETS).toContain(550);
    expect(BRUSH_SIZE_PRESETS).toContain(1000);
    expect(BRUSH_SIZE_PRESETS).toContain(1100);
    expect(BRUSH_SIZE_PRESETS.at(-1)).toBe(2000);
  });

  it("is strictly ascending", () => {
    for (let i = 1; i < BRUSH_SIZE_PRESETS.length; i += 1) {
      expect(BRUSH_SIZE_PRESETS[i]).toBeGreaterThan(BRUSH_SIZE_PRESETS[i - 1] ?? 0);
    }
  });
});

describe("CORNER_SIZE_PRESETS (TL-SHAPE-02)", () => {
  it("runs 1 to 15, by 5 to 100 and by 25 to 250", () => {
    expect(CORNER_SIZE_PRESETS.at(-1)).toBe(250);
    expect(CORNER_SIZE_PRESETS).toContain(100);
    expect(CORNER_SIZE_PRESETS).toContain(125);
    expect(CORNER_SIZE_PRESETS).not.toContain(16);
    expect(CORNER_SIZE_PRESETS).not.toContain(260);
  });
});
