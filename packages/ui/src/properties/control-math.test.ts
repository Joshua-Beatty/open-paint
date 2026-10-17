import { describe, expect, it } from "vitest";
import {
  angleOf,
  axesOf,
  clampTo,
  decimalsOf,
  defaultSteps,
  exponentOf,
  fractionAtPoint,
  fractionOf,
  keyboardValue,
  magnitudeStepValue,
  type Range,
  rangeOf,
  roundTo,
  sliderBackground,
  snapValue,
  stepSettings,
  stepValue,
  tickFractions,
  valueAtFraction,
  wrapValue,
} from "./control-math";

const UNIT: Range = { min: 0, max: 1 };
const SEED: Range = { min: 0, max: 255 };
const ANGLE: Range = { min: -180, max: 180 };

describe("ranges and defaults", () => {
  it("reads the range of scalar and per-axis vector properties", () => {
    const int = {
      kind: "int32",
      key: "a",
      label: "layers.dialog.name",
      defaultValue: 1,
      min: 0,
      max: 9,
    } as const;
    expect(rangeOf(int)).toEqual({ min: 0, max: 9 });
    const pan = {
      kind: "vector2",
      key: "p",
      label: "layers.dialog.name",
      defaultValue: { x: 0, y: 0 },
      min: { x: -1, y: -2 },
      max: { x: 1, y: 2 },
    } as const;
    expect(rangeOf(pan, "y")).toEqual({ min: -2, max: 2 });
    expect(axesOf(pan)).toEqual(["x", "y"]);
  });

  it("uses 1 and a tenth for integers and 1% and 10% for doubles when no step is set", () => {
    expect(defaultSteps({ min: 2, max: 1000 }, true)).toEqual({ small: 1, large: 100 });
    expect(defaultSteps(UNIT, false)).toEqual({ small: 0.01, large: 0.1 });
  });

  it("prefers axis-specific steps over the shared ones", () => {
    const control = { sliderSmallChange: 0.5, sliderSmallChangeX: 0.1, upDownIncrement: 2 };
    expect(stepSettings(control, UNIT, false, "x").small).toBe(0.1);
    expect(stepSettings(control, UNIT, false, "y").small).toBe(0.5);
    expect(stepSettings(control, UNIT, false, "y").increment).toBe(2);
    expect(stepSettings(undefined, UNIT, false).ticks).toBe(false);
  });

  it("reads decimals and the exponent with their defaults", () => {
    expect(decimalsOf(undefined, true)).toBe(0);
    expect(decimalsOf(undefined, false)).toBe(2);
    expect(decimalsOf({ decimalPlaces: 4 }, false)).toBe(4);
    expect(exponentOf({ useExponentialScale: true })).toBe(2);
    expect(exponentOf({ useExponentialScale: true, exponentialScale: 3 })).toBe(3);
    expect(exponentOf({ exponentialScale: 3 })).toBeUndefined();
  });
});

describe("stepping and snapping", () => {
  it("steps by the given delta and stops at the ends without wrapping", () => {
    expect(stepValue(5, 1, SEED, false)).toBe(6);
    expect(stepValue(255, 1, SEED, false)).toBe(255);
    expect(stepValue(0, -1, SEED, false)).toBe(0);
  });

  it("wraps 255 back to 0 when wrapping is on (FX-SHARED-SEED)", () => {
    expect(stepValue(255, 1, SEED, true)).toBe(0);
    expect(stepValue(0, -1, SEED, true)).toBe(255);
  });

  it("snaps to the step grid from the minimum and clamps", () => {
    expect(snapValue(0.26, UNIT, 0.1)).toBe(0.3);
    expect(snapValue(7.4, { min: 0, max: 10 }, 1)).toBe(7);
    expect(snapValue(12, { min: 0, max: 10 }, 1)).toBe(10);
    expect(snapValue(0.333, UNIT, 0)).toBe(0.333);
  });

  it("rounds away binary noise", () => {
    expect(roundTo(0.1 + 0.2, 10)).toBe(0.3);
    expect(clampTo(3, { min: 0, max: 2 })).toBe(2);
  });
});

describe("magnitude steps of whole-number fields", () => {
  const SIZE: Range = { min: 1, max: 2000 };
  const up = (value: number) => magnitudeStepValue(value, 1, SIZE);
  const down = (value: number) => magnitudeStepValue(value, -1, SIZE);
  const walk = (from: number, step: (value: number) => number, count: number) => {
    const values = [from];
    for (let index = 0; index < count; index++) values.push(step(values.at(-1) ?? from));
    return values;
  };

  it("steps by 1 below 20, 2 to 49, 5 to 99, 10 to 199, then 25, 50 and 100", () => {
    expect(walk(17, up, 6)).toEqual([17, 18, 19, 20, 22, 24, 26]);
    expect(walk(46, up, 4)).toEqual([46, 48, 50, 55, 60]);
    expect(walk(90, up, 4)).toEqual([90, 95, 100, 110, 120]);
    expect(walk(190, up, 3)).toEqual([190, 200, 225, 250]);
    expect(walk(475, up, 3)).toEqual([475, 500, 550, 600]);
    expect(walk(950, up, 3)).toEqual([950, 1000, 1100, 1200]);
  });

  it("steps down symmetrically: from a band's start it takes the smaller step below", () => {
    expect(walk(26, down, 6)).toEqual([26, 24, 22, 20, 19, 18, 17]);
    expect(walk(60, down, 4)).toEqual([60, 55, 50, 48, 46]);
    expect(walk(120, down, 4)).toEqual([120, 110, 100, 95, 90]);
    expect(walk(1100, down, 2)).toEqual([1100, 1000, 950]);
    // Walking down retraces every value that walking up from the minimum visits.
    const ladder = walk(1, up, 100).filter((value, index, all) => all.indexOf(value) === index);
    expect(ladder.at(-1)).toBe(2000);
    for (let index = 1; index < ladder.length; index++) {
      expect(down(ladder[index] ?? 0)).toBe(ladder[index - 1]);
    }
  });

  it("snaps an off-step value to the step's multiples", () => {
    expect(up(21)).toBe(22);
    expect(down(21)).toBe(20);
    expect(up(57)).toBe(60);
    expect(down(57)).toBe(55);
    expect(up(2.5)).toBe(3);
    expect(down(2.5)).toBe(2);
    expect(up(123)).toBe(130);
  });

  it("stays whole, stops at the range ends, takes several steps, and mirrors negatives", () => {
    expect(down(1)).toBe(1);
    expect(up(2000)).toBe(2000);
    expect(magnitudeStepValue(18, 3, SIZE)).toBe(22);
    expect(magnitudeStepValue(22, -3, SIZE)).toBe(18);
    const ANGLE_RANGE: Range = { min: -180, max: 180 };
    expect(magnitudeStepValue(0, -1, ANGLE_RANGE)).toBe(-1);
    expect(magnitudeStepValue(-20, -1, ANGLE_RANGE)).toBe(-22);
    expect(magnitudeStepValue(-20, 1, ANGLE_RANGE)).toBe(-19);
    expect(magnitudeStepValue(-1, 1, ANGLE_RANGE)).toBe(0);
    for (let value = 1; value < 2000; value++) expect(Number.isInteger(up(value))).toBe(true);
  });

  it("takes five times the step with Ctrl, on its multiples", () => {
    expect(magnitudeStepValue(18, 1, SIZE, true)).toBe(20);
    expect(magnitudeStepValue(20, 1, SIZE, true)).toBe(30);
    expect(magnitudeStepValue(100, 1, SIZE, true)).toBe(150);
    expect(magnitudeStepValue(50, -1, SIZE, true)).toBe(40);
    expect(magnitudeStepValue(3, -1, SIZE, true)).toBe(1);
  });
});

describe("the exponential mapping", () => {
  it("maps values to positions and back", () => {
    for (const value of [0, 0.25, 0.5, 1]) {
      const position = fractionOf(value, UNIT, 2);
      expect(valueAtFraction(position, UNIT, 2)).toBeCloseTo(value, 12);
    }
  });

  it("gives small values more of the track than a linear slider does", () => {
    expect(fractionOf(0.25, UNIT, 2)).toBeCloseTo(0.5, 12);
    expect(fractionOf(0.25, UNIT)).toBeCloseTo(0.25, 12);
  });

  it("returns 0 for a zero-width range", () => {
    expect(fractionOf(5, { min: 5, max: 5 })).toBe(0);
  });
});

describe("tick marks", () => {
  it("places one tick per large step, excluding the ends", () => {
    expect(tickFractions({ min: 0, max: 100 }, 25)).toEqual([0.25, 0.5, 0.75]);
  });

  it("draws no ticks when the large step is missing or too fine", () => {
    expect(tickFractions({ min: 0, max: 100 }, 0)).toEqual([]);
    expect(tickFractions({ min: 0, max: 100 }, 0.5)).toEqual([]);
  });
});

describe("keyboard model", () => {
  const steps = { small: 1, large: 10, increment: 1, ticks: false };
  const range = { min: 0, max: 100 };

  it("maps arrows to small steps, page keys to large steps and Home and End to the ends", () => {
    expect(keyboardValue("ArrowRight", 50, steps, range, false)).toBe(51);
    expect(keyboardValue("ArrowUp", 50, steps, range, false)).toBe(51);
    expect(keyboardValue("ArrowLeft", 50, steps, range, false)).toBe(49);
    expect(keyboardValue("PageUp", 50, steps, range, false)).toBe(60);
    expect(keyboardValue("PageDown", 50, steps, range, false)).toBe(40);
    expect(keyboardValue("Home", 50, steps, range, false)).toBe(0);
    expect(keyboardValue("End", 50, steps, range, false)).toBe(100);
  });

  it("returns undefined for keys that are not slider keys", () => {
    expect(keyboardValue("a", 50, steps, range, false)).toBeUndefined();
  });

  it("wraps when the range wraps", () => {
    expect(keyboardValue("ArrowRight", 100, steps, range, true)).toBe(0);
  });
});

describe("pointers and angles", () => {
  it("maps a pointer x position to a track fraction", () => {
    expect(fractionAtPoint(150, 100, 200)).toBe(0.25);
    expect(fractionAtPoint(50, 100, 200)).toBe(0);
    expect(fractionAtPoint(400, 100, 200)).toBe(1);
  });

  it("returns undefined for a track with no width (for example in a headless layout)", () => {
    expect(fractionAtPoint(10, 0, 0)).toBeUndefined();
  });

  it("measures dial angles clockwise from 3 o'clock", () => {
    expect(angleOf(1, 0)).toBeCloseTo(0, 10);
    expect(angleOf(0, 1)).toBeCloseTo(90, 10);
    expect(angleOf(-1, 0)).toBeCloseTo(180, 10);
  });

  it("wraps angles into the range", () => {
    expect(wrapValue(190, ANGLE)).toBeCloseTo(-170, 10);
    expect(wrapValue(-180, ANGLE)).toBe(-180);
    expect(wrapValue(10, { min: 5, max: 5 })).toBe(5);
  });
});

describe("slider background", () => {
  it("uses custom colors first, then the named style", () => {
    expect(sliderBackground({ controlColors: ["#000", "#fff"] })).toBe(
      "linear-gradient(to right, #000, #fff)",
    );
    expect(sliderBackground({ controlStyle: "hue" })).toContain("#ff0000");
    expect(sliderBackground({ controlStyle: "hueCentered" })).toContain("#ff0000");
    expect(sliderBackground({ controlStyle: "saturationHue" })).toContain("#808080");
    expect(sliderBackground({ controlStyle: "default" })).toBeUndefined();
    expect(sliderBackground(undefined)).toBeUndefined();
  });
});
