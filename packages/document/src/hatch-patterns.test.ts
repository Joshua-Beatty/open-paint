import { describe, expect, it } from "vitest";
import { HATCH_PATTERNS, HatchPatternRegistry } from "./hatch-patterns";

describe("HATCH_PATTERNS (TL-OPT-FILL)", () => {
  it("lists the eight built-in patterns in the order of the Rust table", () => {
    expect(HATCH_PATTERNS.ids()).toEqual([
      "Horizontal",
      "Vertical",
      "ForwardDiagonal",
      "BackwardDiagonal",
      "Cross",
      "DiagonalCross",
      "Percent50",
      "DottedGrid",
    ]);
  });

  it("ranks a pattern from 1, and an unknown id as 0", () => {
    expect(HATCH_PATTERNS.rank("Horizontal")).toBe(1);
    expect(HATCH_PATTERNS.rank("DottedGrid")).toBe(8);
    expect(HATCH_PATTERNS.rank("Wavy")).toBe(0);
    expect(HATCH_PATTERNS.rank(undefined)).toBe(0);
  });
});

describe("HatchPatternRegistry", () => {
  it("takes a new pattern at the end without changing the others", () => {
    const registry = new HatchPatternRegistry();
    registry.register("Dots");
    registry.register("Waves");
    expect(registry.ids()).toEqual(["Dots", "Waves"]);
    expect(registry.rank("Waves")).toBe(2);
  });

  it("refuses a duplicate id", () => {
    const registry = new HatchPatternRegistry();
    registry.register("Dots");
    expect(() => registry.register("Dots")).toThrow();
  });
});
