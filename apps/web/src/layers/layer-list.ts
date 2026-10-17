/** The height of one layer row in CSS px. The stylesheet uses the same value (`.app-layer-row`). */
export const LAYER_ROW_HEIGHT = 40;

/** The longer side of a layer thumbnail in pixels: twice its box, for high-DPI screens. */
export const LAYER_THUMBNAIL_SIZE = 64;

/**
 * The largest box a layer thumbnail is shown in, in CSS px. The stylesheet sizes the slot to it
 * (`.app-layer-thumb`), and the thumbnail takes the image's aspect ratio inside it (UI-FTW-05).
 */
export const LAYER_THUMBNAIL_BOX = { width: 40, height: 26 } as const;

/** The pointer travel, in CSS px, before a press on a row becomes a drag. */
export const DRAG_THRESHOLD = 4;

/**
 * The layer index a drag ends at (UI-FTW-05, DOC-LYR-05). `dy` is the pointer's vertical travel in
 * CSS px, positive when moved down. Rows are counted from the top, and layer 0 is the bottom. The
 * result is clamped to the list.
 */
export function dragTargetIndex(from: number, count: number, dy: number): number {
  const rows = Math.round(dy / LAYER_ROW_HEIGHT);
  return Math.min(count - 1, Math.max(0, from - rows));
}

/**
 * The vertical offset in CSS px of a row that is not being dragged, while the dragged layer moves
 * from `from` to `target`. The layers in between step aside by one row, so the gap shows where the
 * layer will land.
 */
export function rowShift(index: number, from: number, target: number): number {
  if (target > from && index > from && index <= target) return LAYER_ROW_HEIGHT;
  if (target < from && index >= target && index < from) return -LAYER_ROW_HEIGHT;
  return 0;
}

/**
 * The index of the visible layer nearest to `index`, for "Auto-select nearest visible layer after
 * hiding a layer" (DOC-LYR-05o). Ties go to the layer above. Returns undefined when none is
 * visible.
 */
export function nearestVisibleIndex(
  visible: readonly boolean[],
  index: number,
): number | undefined {
  for (let distance = 1; distance < visible.length; distance++) {
    const above = index + distance;
    if (above < visible.length && visible[above] === true) return above;
    const below = index - distance;
    if (below >= 0 && visible[below] === true) return below;
  }
  return undefined;
}
