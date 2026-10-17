/**
 * The index of the first item that does not fit in a row, or undefined when all of them fit.
 * Items keep their order and are separated by `gap`. When some do not fit, the row also makes room
 * for the More button (`moreWidth` plus a gap) after the last item it keeps.
 */
export function firstHidden(
  widths: readonly number[],
  gap: number,
  rowWidth: number,
  moreWidth: number,
): number | undefined {
  const total = widths.reduce((sum, width, index) => sum + width + (index > 0 ? gap : 0), 0);
  // Half a pixel of slack absorbs sub-pixel rounding of the measured widths.
  if (total <= rowWidth + 0.5) return undefined;
  const budget = rowWidth - moreWidth - gap + 0.5;
  let used = 0;
  for (const [index, width] of widths.entries()) {
    const next = used + (index > 0 ? gap : 0) + width;
    if (next > budget) return index;
    used = next;
  }
  return widths.length;
}
