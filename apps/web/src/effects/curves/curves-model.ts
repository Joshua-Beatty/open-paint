import {
  CURVE_IDENTITY,
  type CurveList,
  type CurveMode,
  type CurvePoint,
} from "@openpaint/effects";

/** A curve in the dialog: the luminosity curve, or one of the RGB curves (ADJ-CURVES-UI-02). */
export type CurveKey = "luminosity" | "red" | "green" | "blue";

/** The dialog's edits: the transfer mode, every curve's points and the RGB channel checkboxes. */
export interface CurveEditState {
  readonly mode: CurveMode;
  readonly lists: Readonly<Record<CurveKey, CurveList>>;
  readonly checked: Readonly<Record<"red" | "green" | "blue", boolean>>;
}

/** A point under the pointer counts as hit when its squared distance is below this (ADJ-CURVES-UI-07). */
export const HIT_DISTANCE_SQUARED = 30;

/**
 * What one channel of a press or drag tracks (ADJ-CURVES-UI-08). `x` is the column of the point being
 * moved, or undefined before the first placement. `end` marks an end point, which is never removed.
 * `displaced` is the point the drag overwrote at its column, which comes back when the drag leaves.
 */
export interface ChannelDrag {
  readonly key: CurveKey;
  readonly x: number | undefined;
  readonly end: boolean;
  readonly displaced: CurvePoint | undefined;
}

/** The curves a mode shows, in order (ADJ-CURVES-UI-02). */
export function modeKeys(mode: CurveMode): readonly CurveKey[] {
  return mode === "rgb" ? ["red", "green", "blue"] : ["luminosity"];
}

/** The curves a press or drag may edit: the luminosity curve, or the checked RGB channels (ADJ-CURVES-UI-03). */
export function editableKeys(state: CurveEditState): readonly CurveKey[] {
  return modeKeys(state.mode).filter((key) => key === "luminosity" || state.checked[key]);
}

/** The curve point of a pointer position, from its position in the plot (ADJ-CURVES-UI-05). */
export function curveAt(px: number, py: number, width: number, height: number): CurvePoint {
  const x = Math.floor(0.5 + (px * 255) / (width - 1));
  const y = Math.floor(255.5 - (py * 255) / (height - 1));
  return [clampCoordinate(x), clampCoordinate(y)];
}

function clampCoordinate(value: number): number {
  return Math.min(255, Math.max(0, value));
}

function isEndColumn(x: number): boolean {
  return x === 0 || x === 255;
}

function sortByX(points: readonly CurvePoint[]): CurvePoint[] {
  return [...points].sort((a, b) => a[0] - b[0]);
}

/** The index of the point nearest to (x, y) within HIT_DISTANCE_SQUARED, or undefined (ADJ-CURVES-UI-07). */
export function nearestPoint(list: CurveList, x: number, y: number): number | undefined {
  let best: number | undefined;
  let bestDistance = HIT_DISTANCE_SQUARED;
  list.forEach(([px, py], index) => {
    const distance = (px - x) ** 2 + (py - y) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/** The point under (x, y) across the given curves, the one nearest the pointer, for the hover highlight. */
export function hoverPoint(
  lists: Readonly<Record<CurveKey, CurveList>>,
  keys: readonly CurveKey[],
  x: number,
  y: number,
): { readonly key: CurveKey; readonly x: number } | undefined {
  let best: { key: CurveKey; x: number; distance: number } | undefined;
  for (const key of keys) {
    const index = nearestPoint(lists[key], x, y);
    if (index === undefined) continue;
    const [px, py] = lists[key][index] ?? [0, 0];
    const distance = (px - x) ** 2 + (py - y) ** 2;
    if (best === undefined || distance < best.distance) best = { key, x: px, distance };
  }
  return best === undefined ? undefined : { key: best.key, x: best.x };
}

/**
 * Starts a press at (x, y) (ADJ-CURVES-UI-08). A press on an interior point picks it up, and only
 * the curves that had a point there take part. A press on an end point takes that point. A press
 * on empty space creates the point in every editable curve. The first placement follows at once.
 */
export function pressCurves(
  lists: Readonly<Record<CurveKey, CurveList>>,
  keys: readonly CurveKey[],
  x: number,
  y: number,
): {
  readonly lists: Readonly<Record<CurveKey, CurveList>>;
  readonly drag: readonly ChannelDrag[];
} {
  const hits = keys.map((key) => ({ key, index: nearestPoint(lists[key], x, y) }));
  const anyHit = hits.some((hit) => hit.index !== undefined);
  const participants = anyHit ? hits.filter((hit) => hit.index !== undefined) : hits;
  const next: Record<CurveKey, CurveList> = { ...lists };
  const pressed: ChannelDrag[] = participants.map(({ key, index }) => {
    if (index === undefined) return { key, x: undefined, end: false, displaced: undefined };
    const point = next[key][index];
    if (point === undefined) return { key, x: undefined, end: false, displaced: undefined };
    if (isEndColumn(point[0])) return { key, x: point[0], end: true, displaced: undefined };
    next[key] = next[key].filter((_, position) => position !== index);
    return { key, x: undefined, end: false, displaced: undefined };
  });
  return dragCurves(next, pressed, x, y);
}

/** Moves the dragged points of every participating curve to (x, y) (ADJ-CURVES-UI-08). */
export function dragCurves(
  lists: Readonly<Record<CurveKey, CurveList>>,
  drag: readonly ChannelDrag[],
  x: number,
  y: number,
): {
  readonly lists: Readonly<Record<CurveKey, CurveList>>;
  readonly drag: readonly ChannelDrag[];
} {
  const next: Record<CurveKey, CurveList> = { ...lists };
  const moved = drag.map((channel) => {
    const step = moveChannel(next[channel.key], channel, x, y);
    next[channel.key] = step.list;
    return step.drag;
  });
  return { lists: next, drag: moved };
}

function moveChannel(
  list: CurveList,
  drag: ChannelDrag,
  x: number,
  y: number,
): { readonly list: CurveList; readonly drag: ChannelDrag } {
  const { key } = drag;
  if (drag.x === x) {
    return {
      list: list.map((point): CurvePoint => (point[0] === x ? [x, y] : point)),
      drag,
    };
  }
  let next: CurvePoint[] = [...list];
  if (drag.x !== undefined) {
    if (!drag.end) next = next.filter((point) => point[0] !== drag.x);
    if (drag.displaced !== undefined) next.push(drag.displaced);
  }
  const existing = next.find((point) => point[0] === x);
  if (existing !== undefined && isEndColumn(x)) {
    return {
      list: sortByX(next.map((point): CurvePoint => (point[0] === x ? [x, y] : point))),
      drag: { key, x, end: true, displaced: undefined },
    };
  }
  if (existing !== undefined) {
    next = next.filter((point) => point !== existing);
    next.push([x, y]);
    return {
      list: sortByX(next),
      drag: { key, x, end: false, displaced: existing },
    };
  }
  next.push([x, y]);
  return {
    list: sortByX(next),
    drag: { key, x, end: isEndColumn(x), displaced: undefined },
  };
}

/**
 * Removes the point under (x, y) from each editable curve that has one, except end points
 * (ADJ-CURVES-UI-09). Returns the same lists when nothing was removed.
 */
export function removePoints(
  lists: Readonly<Record<CurveKey, CurveList>>,
  keys: readonly CurveKey[],
  x: number,
  y: number,
): Readonly<Record<CurveKey, CurveList>> {
  const next: Record<CurveKey, CurveList> = { ...lists };
  for (const key of keys) {
    const index = nearestPoint(lists[key], x, y);
    if (index === undefined) continue;
    const point = lists[key][index];
    if (point === undefined || isEndColumn(point[0])) continue;
    next[key] = lists[key].filter((_, position) => position !== index);
  }
  return next;
}

/** The identity curves of the visible mode (ADJ-CURVES-UI-10). The other mode's curves are kept. */
export function resetMode(
  lists: Readonly<Record<CurveKey, CurveList>>,
  mode: CurveMode,
): Readonly<Record<CurveKey, CurveList>> {
  const next: Record<CurveKey, CurveList> = { ...lists };
  for (const key of modeKeys(mode)) next[key] = CURVE_IDENTITY;
  return next;
}
