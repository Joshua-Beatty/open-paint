/** An inclusive run of preset sizes: from, to and the step between them. */
type PresetRun = readonly [from: number, to: number, step: number];

/** Expands runs of preset sizes into one ascending list. */
function presetsOf(runs: readonly PresetRun[]): readonly number[] {
  return runs.flatMap(([from, to, step]) => {
    const values: number[] = [];
    for (let value = from; value <= to; value += step) values.push(value);
    return values;
  });
}

/** The Brush size presets (TL-OPT-BRUSH): 1–15, 20–100 by 5, 125–500 by 25, 550–1000 by 50, 1100–2000 by 100. */
export const BRUSH_SIZE_PRESETS: readonly number[] = presetsOf([
  [1, 15, 1],
  [20, 100, 5],
  [125, 500, 25],
  [550, 1000, 50],
  [1100, 2000, 100],
]);

/** The Corner size presets (TL-SHAPE-02): 1–15, 20–100 by 5, 125–250 by 25. */
export const CORNER_SIZE_PRESETS: readonly number[] = presetsOf([
  [1, 15, 1],
  [20, 100, 5],
  [125, 250, 25],
]);
