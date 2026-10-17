import {
  type ChannelTriple,
  LEVELS_GAMMA_MAX,
  LEVELS_GAMMA_MIN,
  type LevelsParams,
} from "@openpaint/effects";

/** A parameter the dialog edits. The points run 0..1 and show as 0..255; gamma runs 0.1..10. */
export type LevelsField = keyof LevelsParams;

/** Which of R, G and B a control edits (ADJ-LEVELS-UI-05). */
export type ChannelMask = readonly [boolean, boolean, boolean];

export const ALL_CHANNELS: ChannelMask = [true, true, true];

/** The highest value a point shows and a nub can reach (ADJ-LEVELS-UI-02). */
export const SHOWN_MAX = 255;

/** Spreading stops when the checked average is this close to the target (points). */
const POINT_TOLERANCE = 1e-6;
/** Spreading stops when the checked average of the gamma is this close (ADJ-LEVELS-UI-05a). */
const GAMMA_TOLERANCE = 0.001;
const MAX_SPREAD_ITERATIONS = 10000;
/** The smallest ratio a histogram position may take before a logarithm, to stay finite. */
const MIN_RATIO = 1e-12;

export const BINS = 256;

export function isPointField(field: LevelsField): boolean {
  return field !== "gamma";
}

function limits(field: LevelsField): readonly [number, number] {
  return isPointField(field) ? [0, 1] : [LEVELS_GAMMA_MIN, LEVELS_GAMMA_MAX];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function checkedIndexes(mask: ChannelMask): number[] {
  return [0, 1, 2].filter((channel) => mask[channel] === true);
}

/** The average of the checked channels of a triple, or undefined when no channel is checked. */
export function averageChecked(triple: ChannelTriple, mask: ChannelMask): number | undefined {
  const indexes = checkedIndexes(mask);
  if (indexes.length === 0) return undefined;
  return indexes.reduce((sum, channel) => sum + (triple[channel] ?? 0), 0) / indexes.length;
}

/**
 * The value a spinner or nub shows for a field: the average of the checked channels (ADJ-LEVELS-UI-05).
 * Points show 0..255, and gamma shows its own value. Undefined when no channel is checked.
 */
export function shownValue(
  params: LevelsParams,
  field: LevelsField,
  mask: ChannelMask,
): number | undefined {
  const average = averageChecked(params[field], mask);
  if (average === undefined) return undefined;
  return isPointField(field) ? average * SHOWN_MAX : average;
}

/**
 * Moves the average of the checked channels to `target` (ADJ-LEVELS-UI-05a). Each checked channel is
 * scaled by the same factor, which keeps their differences in proportion, until the average matches.
 * Any difference left after that is added equally. Unchecked channels are not changed.
 */
export function spreadAverage(
  triple: ChannelTriple,
  mask: ChannelMask,
  target: number,
  [min, max]: readonly [number, number],
  tolerance: number,
): ChannelTriple {
  const indexes = checkedIndexes(mask);
  if (indexes.length === 0) return triple;
  const values = indexes.map((channel) => clamp(triple[channel] ?? min, min, max));
  const average = () => values.reduce((sum, value) => sum + value, 0) / values.length;
  for (let step = 0; step < MAX_SPREAD_ITERATIONS; step++) {
    const current = average();
    if (Math.abs(current - target) <= tolerance || current <= 0) break;
    const scale = target / current;
    for (let index = 0; index < values.length; index++) {
      values[index] = clamp((values[index] ?? min) * scale, min, max);
    }
  }
  const shift = target - average();
  const next: [number, number, number] = [triple[0], triple[1], triple[2]];
  indexes.forEach((channel, index) => {
    next[channel] = clamp((values[index] ?? min) + shift, min, max);
  });
  return next;
}

/**
 * Sets the value a spinner or nub shows for a field, over the checked channels (ADJ-LEVELS-UI-05a).
 * A point takes 0..255 and is stored as 0..1. Gamma takes its own value, clamped to 0.1..10.
 */
export function setShownValue(
  params: LevelsParams,
  field: LevelsField,
  mask: ChannelMask,
  shown: number,
): LevelsParams {
  const range = limits(field);
  const target = clamp(isPointField(field) ? shown / SHOWN_MAX : shown, range[0], range[1]);
  const tolerance = isPointField(field) ? POINT_TOLERANCE : GAMMA_TOLERANCE;
  return {
    ...params,
    [field]: spreadAverage(params[field], mask, target, range, tolerance),
  };
}

/**
 * The range a nub may move in: strictly between its neighbors, and within 0..255 (ADJ-LEVELS-UI-03).
 * `nubs` holds every nub of one gradient in order, in shown values.
 */
export function constrainNub(index: number, value: number, nubs: readonly number[]): number {
  const lower = index === 0 ? 0 : (nubs[index - 1] ?? 0) + 1;
  const upper = index === nubs.length - 1 ? SHOWN_MAX : (nubs[index + 1] ?? SHOWN_MAX) - 1;
  return Math.min(Math.max(value, lower), upper);
}

/** The index of the nub nearest to `value`. The first one wins a tie. */
export function nearestNub(value: number, nubs: readonly number[]): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  nubs.forEach((nub, index) => {
    const distance = Math.abs(nub - value);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/** The shown position of the output middle nub for a gamma (ADJ-LEVELS-UI-03): `lo + (hi - lo) · 0.5^γ`. */
export function midNubPosition(low: number, high: number, gamma: number): number {
  return low + (high - low) * 0.5 ** gamma;
}

/**
 * The gamma that puts the middle nub at `mid`, the inverse of `midNubPosition`:
 * `γ = log₀.₅((mid − lo)/(hi − lo))`, clamped to 0.1..10 (ADJ-LEVELS-UI-03).
 */
export function gammaFromMid(mid: number, low: number, high: number): number {
  const span = high - low;
  if (span <= 0) return 1;
  const ratio = clamp((mid - low) / span, MIN_RATIO, 1);
  return clamp(Math.log(ratio) / Math.log(0.5), LEVELS_GAMMA_MIN, LEVELS_GAMMA_MAX);
}

/**
 * The gamma that maps the image mean to a picked color on one channel (ADJ-LEVELS-UI-04):
 * `γ = log_{t_in}(t_out)`. With `t_in` at 1, the lower clamp is used, and the result is clamped to
 * 0.1..10. Values are native (points 0..1).
 */
export function gammaForMean(
  mean: number,
  inputBlack: number,
  inputWhite: number,
  outputBlack: number,
  outputWhite: number,
  pick: number,
): number {
  const tIn = (mean - inputBlack) / (inputWhite - inputBlack);
  const tOut = (pick - outputBlack) / (outputWhite - outputBlack);
  if (!Number.isFinite(tIn) || !Number.isFinite(tOut) || tIn <= 0 || tIn >= 1) {
    return LEVELS_GAMMA_MIN;
  }
  const gamma = Math.log(Math.max(tOut, MIN_RATIO)) / Math.log(tIn);
  return clamp(gamma, LEVELS_GAMMA_MIN, LEVELS_GAMMA_MAX);
}

/**
 * The mean value of one channel of a 768-bin histogram (R, G, B blocks of 256), as 0..255. With
 * `map`, each value is first sent through it, which gives the mean after a lookup table.
 */
export function channelMean(
  histogram: ArrayLike<number>,
  channel: number,
  map: (value: number) => number = (value) => value,
): number {
  let total = 0;
  let sum = 0;
  for (let value = 0; value < BINS; value++) {
    const count = histogram[channel * BINS + value] ?? 0;
    total += count;
    sum += count * map(value);
  }
  return total === 0 ? 0 : sum / total;
}

/** The output histogram: each input bin re-binned through the Levels table (ADJ-LEVELS-UI-06). */
export function outputHistogram(histogram: ArrayLike<number>, lut: ArrayLike<number>): Uint32Array {
  const out = new Uint32Array(histogram.length);
  for (let channel = 0; channel < 3; channel++) {
    for (let value = 0; value < BINS; value++) {
      const index = channel * BINS + value;
      const target = channel * BINS + (lut[index] ?? 0);
      out[target] = (out[target] ?? 0) + (histogram[index] ?? 0);
    }
  }
  return out;
}

/** Each bin plus its two neighbors (ADJ-LEVELS-UI-06). The ends use the neighbors they have. */
export function smoothBins(bins: ArrayLike<number>): number[] {
  return Array.from({ length: bins.length }, (_, index) => {
    let sum = bins[index] ?? 0;
    if (index > 0) sum += bins[index - 1] ?? 0;
    if (index < bins.length - 1) sum += bins[index + 1] ?? 0;
    return sum;
  });
}

/**
 * The points of one channel's histogram polygon, drawn vertically (ADJ-LEVELS-UI-06). Level 0 is at
 * the bottom and 255 at the top. The bars grow leftward from the right edge when `mirrored` (the
 * input histogram), and rightward from the left edge otherwise. Scale: the smoothed count over
 * `3.1 × maxBin`, as a share of the width.
 */
export function histogramPolygon(
  bins: ArrayLike<number>,
  maxBin: number,
  size: { readonly width: number; readonly height: number },
  mirrored: boolean,
): string {
  const { width, height } = size;
  const smoothed = smoothBins(bins);
  const edge = mirrored ? width : 0;
  const points = smoothed.map((sum, index) => {
    const length = maxBin > 0 ? (width * sum) / (3.1 * maxBin) : 0;
    const x = mirrored ? width - length : length;
    const y = height - (index / (BINS - 1)) * height;
    return `${round(x)},${round(y)}`;
  });
  return [`${edge},${height}`, ...points, `${edge},0`].join(" ");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The largest single bin over the three channels of a histogram. */
export function largestBin(histogram: ArrayLike<number>): number {
  let max = 0;
  for (let index = 0; index < histogram.length; index++) {
    max = Math.max(max, histogram[index] ?? 0);
  }
  return max;
}

/** The output of a Levels table at one 0..255 value, for one channel. */
export function lutValue(lut: ArrayLike<number>, channel: number, value: number): number {
  return lut[channel * BINS + value] ?? 0;
}
