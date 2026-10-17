import { LEVELS_IDENTITY, type LevelsParams } from "@openpaint/effects";
import { describe, expect, it } from "vitest";
import {
  ALL_CHANNELS,
  averageChecked,
  channelMean,
  constrainNub,
  gammaForMean,
  gammaFromMid,
  histogramPolygon,
  largestBin,
  midNubPosition,
  nearestNub,
  outputHistogram,
  setShownValue,
  shownValue,
  smoothBins,
  spreadAverage,
} from "./levels-model";

const ONLY_RED = [true, false, false] as const;
const RED_GREEN = [true, true, false] as const;

function near(actual: readonly number[], expected: readonly number[], digits = 6): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((value, index) => {
    expect(value).toBeCloseTo(expected[index] ?? Number.NaN, digits);
  });
}

describe("checked-channel averages (ADJ-LEVELS-UI-05)", () => {
  it("averages only the checked channels", () => {
    expect(averageChecked([0.2, 0.4, 0.9], RED_GREEN)).toBeCloseTo(0.3);
    expect(averageChecked([0.2, 0.4, 0.9], [false, false, false])).toBeUndefined();
  });

  it("shows points as 0..255 and gamma as its own value", () => {
    const params: LevelsParams = { ...LEVELS_IDENTITY, inputBlack: [0.5, 0, 0] };
    expect(shownValue(params, "inputBlack", ALL_CHANNELS)).toBeCloseTo(255 / 6);
    expect(shownValue(params, "inputBlack", ONLY_RED)).toBeCloseTo(127.5);
    expect(shownValue(params, "gamma", ALL_CHANNELS)).toBe(1);
    expect(shownValue(params, "gamma", [false, false, false])).toBeUndefined();
  });
});

describe("spreading an edit over the checked channels (ADJ-LEVELS-UI-05a)", () => {
  it("scales the checked channels in proportion so their average reaches the target", () => {
    const next = spreadAverage([0.2, 0.4, 0.9], RED_GREEN, 0.6, [0, 1], 1e-9);
    expect(averageChecked(next, RED_GREEN)).toBeCloseTo(0.6, 9);
    expect(next[0] / next[1]).toBeCloseTo(0.5, 9);
  });

  it("leaves unchecked channels alone", () => {
    const next = spreadAverage([0.2, 0.4, 0.9], ONLY_RED, 0.7, [0, 1], 1e-9);
    expect(next[1]).toBe(0.4);
    expect(next[2]).toBe(0.9);
    expect(next[0]).toBeCloseTo(0.7, 9);
  });

  it("reaches a target that the range allows by scaling both channels up to the limit", () => {
    const next = spreadAverage([0.5, 0.5, 0.5], RED_GREEN, 1, [0, 1], 1e-9);
    expect(averageChecked(next, RED_GREEN)).toBeCloseTo(1, 9);
    expect(next[0]).toBeCloseTo(next[1] ?? Number.NaN, 9);
  });

  it("raises zero channels by an equal amount when they cannot be scaled", () => {
    const next = spreadAverage([0, 0, 0], ALL_CHANNELS, 0.3, [0, 1], 1e-9);
    near(next, [0.3, 0.3, 0.3]);
  });

  it("keeps every value within its range", () => {
    const next = spreadAverage([0.1, 0.9, 0.5], ALL_CHANNELS, 5, [0.1, 10], 1e-3);
    for (const value of next) {
      expect(value).toBeGreaterThanOrEqual(0.1);
      expect(value).toBeLessThanOrEqual(10);
    }
  });

  it("sets a point from its shown 0..255 value", () => {
    const next = setShownValue(LEVELS_IDENTITY, "inputWhite", ALL_CHANNELS, 128);
    near(next.inputWhite, [128 / 255, 128 / 255, 128 / 255], 6);
    expect(next.inputBlack).toEqual(LEVELS_IDENTITY.inputBlack);
  });

  it("clamps a point to 0..255 and gamma to 0.1..10", () => {
    expect(setShownValue(LEVELS_IDENTITY, "outputWhite", ALL_CHANNELS, 900).outputWhite).toEqual([
      1, 1, 1,
    ]);
    near(setShownValue(LEVELS_IDENTITY, "gamma", ALL_CHANNELS, 0).gamma, [0.1, 0.1, 0.1]);
    const high = setShownValue(LEVELS_IDENTITY, "gamma", ONLY_RED, 99);
    expect(high.gamma[0]).toBeCloseTo(10, 6);
  });

  it("keeps the difference between checked channels for gamma", () => {
    const params: LevelsParams = { ...LEVELS_IDENTITY, gamma: [2, 1, 1] };
    const next = setShownValue(params, "gamma", RED_GREEN, 1.5);
    expect(averageChecked(next.gamma, RED_GREEN)).toBeCloseTo(1.5, 3);
    expect(next.gamma[0] / next.gamma[1]).toBeCloseTo(2, 2);
    expect(next.gamma[2]).toBe(1);
  });
});

describe("nub limits (ADJ-LEVELS-UI-03)", () => {
  it("keeps a nub strictly between its neighbors", () => {
    const nubs = [50, 200];
    expect(constrainNub(0, 300, nubs)).toBe(199);
    expect(constrainNub(1, 0, nubs)).toBe(51);
    expect(constrainNub(1, 300, nubs)).toBe(255);
    expect(constrainNub(0, -5, nubs)).toBe(0);
  });

  it("keeps the middle output nub between the outer nubs", () => {
    const nubs = [10, 100, 240];
    expect(constrainNub(1, 5, nubs)).toBe(11);
    expect(constrainNub(1, 250, nubs)).toBe(239);
  });

  it("picks the nearest nub, and the first one on a tie", () => {
    expect(nearestNub(60, [50, 200])).toBe(0);
    expect(nearestNub(180, [50, 200])).toBe(1);
    expect(nearestNub(125, [50, 200])).toBe(0);
  });
});

describe("the output middle nub and gamma (ADJ-LEVELS-UI-03)", () => {
  it("puts the middle nub at lo + (hi - lo) · 0.5^γ", () => {
    expect(midNubPosition(0, 255, 1)).toBeCloseTo(127.5);
    expect(midNubPosition(0, 255, 2)).toBeCloseTo(63.75);
    expect(midNubPosition(55, 255, 1)).toBeCloseTo(155);
  });

  it("inverts the middle nub position back to the gamma", () => {
    for (const gamma of [0.2, 0.5, 1, 2.5, 9]) {
      const mid = midNubPosition(20, 230, gamma);
      expect(gammaFromMid(mid, 20, 230)).toBeCloseTo(gamma, 9);
    }
  });

  it("clamps the gamma from a middle nub to 0.1..10", () => {
    expect(gammaFromMid(0, 0, 255)).toBe(10);
    expect(gammaFromMid(255, 0, 255)).toBe(0.1);
    expect(gammaFromMid(10, 20, 20)).toBe(1);
  });
});

describe("gamma from a picked mid color (ADJ-LEVELS-UI-04)", () => {
  it("maps the image mean to the picked value", () => {
    // t_in = 0.5 and t_out = 0.25, so γ = log_0.5(0.25) = 2.
    expect(gammaForMean(0.5, 0, 1, 0, 1, 0.25)).toBeCloseTo(2, 9);
  });

  it("falls back to the lower clamp when the mean is at the white point", () => {
    expect(gammaForMean(1, 0, 1, 0, 1, 0.5)).toBe(0.1);
  });

  it("clamps the result to 0.1..10", () => {
    expect(gammaForMean(0.5, 0, 1, 0, 1, 0)).toBe(10);
    expect(gammaForMean(0.5, 0, 1, 0, 1, 1)).toBe(0.1);
  });
});

describe("histogram helpers (ADJ-LEVELS-UI-06)", () => {
  it("averages a channel's values, and maps them through a table first", () => {
    const bins = new Uint32Array(768);
    bins[10] = 1;
    bins[20] = 3;
    expect(channelMean(bins, 0)).toBeCloseTo((10 + 3 * 20) / 4);
    expect(channelMean(bins, 0, (value) => value * 2)).toBeCloseTo((20 + 3 * 40) / 4);
    expect(channelMean(bins, 1)).toBe(0);
  });

  it("re-bins each input bin through the table", () => {
    const bins = new Uint32Array(768);
    bins[5] = 4;
    bins[256 + 5] = 2;
    const lut = new Uint8Array(768);
    lut[5] = 100;
    lut[256 + 5] = 7;
    const out = outputHistogram(bins, lut);
    expect(out[100]).toBe(4);
    expect(out[256 + 7]).toBe(2);
    expect(out.reduce((sum, count) => sum + count, 0)).toBe(6);
  });

  it("smooths each bin with its two neighbors, and the ends with the one they have", () => {
    expect(smoothBins([1, 2, 4, 8])).toEqual([3, 7, 14, 12]);
    expect(smoothBins([5])).toEqual([5]);
  });

  it("finds the largest single bin", () => {
    expect(largestBin([1, 9, 3])).toBe(9);
    expect(largestBin([])).toBe(0);
  });

  it("draws the input histogram from the right edge and the output from the left", () => {
    const bins = new Array<number>(256).fill(0);
    bins[0] = 3.1;
    const size = { width: 100, height: 200 };
    const mirrored = histogramPolygon(bins, 1, size, true).split(" ");
    const plain = histogramPolygon(bins, 1, size, false).split(" ");
    expect(mirrored[0]).toBe("100,200");
    expect(mirrored.at(-1)).toBe("100,0");
    expect(mirrored[1]).toBe("0,200");
    expect(plain[1]).toBe("100,200");
  });

  it("scales a count by its width over 3.1 times the largest bin", () => {
    const bins = new Array<number>(256).fill(0);
    bins[128] = 1;
    const points = histogramPolygon(bins, 1, { width: 310, height: 256 }, false).split(" ");
    const x = Number(points[129]?.split(",")[0]);
    expect(x).toBeCloseTo(100, 6);
  });
});
