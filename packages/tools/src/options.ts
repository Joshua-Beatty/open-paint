/**
 * Moves a number by `delta` and clamps it to [min, max] (TL-HOTKEY-02, brush size and tolerance).
 * The result is rounded to nine decimals, so repeated 0.01 steps do not drift.
 */
export function stepValue(value: number, delta: number, min: number, max: number): number {
  const next = Math.min(max, Math.max(min, value + delta));
  return Number(next.toFixed(9));
}

/** The choice after `current` when cycling forward (step 1) or back (step -1), wrapping around. */
export function cycleChoice<T>(choices: readonly T[], current: T, step: 1 | -1): T {
  const count = choices.length;
  const index = choices.indexOf(current);
  const next = (((index + step) % count) + count) % count;
  const choice = choices[next];
  if (choice === undefined) throw new Error("cycleChoice needs at least one choice.");
  return choice;
}
