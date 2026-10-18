/**
 * The segments the tip is swept along for `count` dabs, as index pairs (TL-BRUSH-01). Joined dabs
 * (spacing below 100 %) make a polyline: each dab to the next, or a lone dab to itself. Spaced
 * dabs are each a tip of their own. Matches `visit_dabs` in `crates/opaint-cpu/src/brush.rs`.
 */
export function segmentsOf(count: number, joined: boolean): [number, number][] {
  const segments: [number, number][] = [];
  if (joined && count > 1) {
    for (let i = 0; i + 1 < count; i++) segments.push([i, i + 1]);
  } else {
    for (let i = 0; i < count; i++) segments.push([i, i]);
  }
  return segments;
}

/** How far past its radius an antialiased tip reaches: its rim fades over 1 px centred on it. */
export function tipPad(antialias: boolean): number {
  return antialias ? 0.5 : 0;
}

/** The hardness as the Rust kernels clamp it: 0 to 1, NaN as 0. */
export function clampHardness(hardness: number): number {
  return Number.isNaN(hardness) ? 0 : Math.min(1, Math.max(0, hardness));
}
