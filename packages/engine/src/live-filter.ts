import type { Rect, Surface } from "@openpaint/document";
import { pixelAdjustment } from "@openpaint/effects";
import type { LiveFilter } from "./composite";

/**
 * Applies a layer's live filter (FX-FW-PREVIEW-01) to `surface` in place: straight RGBA8 pixels
 * whose pixel (i, j) shows document pixel (`x0 + i × step`, `y0 + j × step`). The adjustment runs
 * with its CPU reference, and only inside the filter's region; a partly selected pixel mixes the
 * original and the adjusted pixel by its coverage, as the effect's output is clipped
 * (`clipToCoverage`). An unknown effect leaves the pixels as they are.
 */
export function applyLiveFilter(
  surface: Surface,
  live: LiveFilter,
  x0: number,
  y0: number,
  step: number,
): void {
  const adjustment = pixelAdjustment(live.effectId);
  if (adjustment === undefined || surface.width === 0 || surface.height === 0) return;
  const { region, coverage } = live;
  const columns = span(region.x, region.width, x0, step, surface.width);
  const rows = span(region.y, region.height, y0, step, surface.height);
  if (columns === undefined || rows === undefined) return;
  const whole =
    coverage === undefined &&
    columns.from === 0 &&
    rows.from === 0 &&
    columns.to === surface.width &&
    rows.to === surface.height;
  const adjusted = adjustment.cpu(surface, live.params);
  if (whole) {
    surface.data.set(adjusted.data);
    return;
  }
  const out = surface.data;
  const next = adjusted.data;
  for (let j = rows.from; j < rows.to; j++) {
    const dy = y0 + j * step - region.y;
    for (let i = columns.from; i < columns.to; i++) {
      const c =
        coverage === undefined
          ? 255
          : (coverage[dy * region.width + x0 + i * step - region.x] ?? 0);
      if (c === 0) continue;
      const at = (j * surface.width + i) * 4;
      if (c === 255) {
        out[at] = next[at] ?? 0;
        out[at + 1] = next[at + 1] ?? 0;
        out[at + 2] = next[at + 2] ?? 0;
        out[at + 3] = next[at + 3] ?? 0;
        continue;
      }
      for (let k = 0; k < 4; k++) {
        out[at + k] = Math.floor(
          ((out[at + k] ?? 0) * (255 - c) + (next[at + k] ?? 0) * c + 127) / 255,
        );
      }
    }
  }
}

/**
 * The surface columns (or rows) `from ≤ i < to` whose document position `origin + i × step` lies
 * in `[start, start + length)`, or undefined when none does.
 */
function span(
  start: number,
  length: number,
  origin: number,
  step: number,
  count: number,
): { from: number; to: number } | undefined {
  const from = Math.max(0, Math.ceil((start - origin) / step));
  const to = Math.min(count, Math.ceil((start + length - origin) / step));
  return to > from ? { from, to } : undefined;
}

/** Whether a document area meets a live filter's region. */
export function meetsLiveFilter(live: LiveFilter, area: Rect): boolean {
  const { region } = live;
  return (
    area.x < region.x + region.width &&
    region.x < area.x + area.width &&
    area.y < region.y + region.height &&
    region.y < area.y + area.height
  );
}
