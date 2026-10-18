/**
 * The parts of a brush stroke's coverage, as `crates/opaint-cpu/src/brush.rs` (`marks`) and
 * `brush_field.rs` (`field_terms`) plan them (TL-BRUSH-01). A round tip's coverage comes from a
 * field whose terms add up: the segments between joined dabs, a cap at each end of the stroke
 * and single dabs. A square tip is swept from each dab to the next and keeps the largest coverage.
 */

/** σ of the round tip's field, as a fraction of the tip's reach (`FIELD_SIGMA`). */
export const FIELD_SIGMA = 0.3;
/** How far a field term reaches, as a multiple of the tip's reach (`FIELD_INFLUENCE`). */
export const FIELD_INFLUENCE = 1.45;
/** The field value 1 in fixed point (`FIELD_ONE`). */
export const FIELD_ONE = 4_194_304;

/** The kind of a stroke part, as the WGSL twins number them. */
export const TERM = { segment: 0, cap: 1, point: 2, square: 3 } as const;

/**
 * One part of a stroke: a kind and two dab indices. A segment and a square sweep run from `a` to
 * `b`; a cap sits on the stroke end `a`, whose path arrives from `b`; a point is the dab `a`.
 */
export interface BrushTerm {
  readonly kind: number;
  readonly a: number;
  readonly b: number;
}

/** What decides a batch's parts. */
export interface TermOptions {
  /** Consecutive dabs are joined (spacing below 100 %). */
  readonly joined: boolean;
  readonly square: boolean;
  /** The batch begins at the stroke's first dab. */
  readonly starts: boolean;
  /** The batch ends the stroke. */
  readonly ends: boolean;
}

/** The parts of a batch of dabs (flat `x, y, diameter` triples). */
export function termsOf(dabs: ArrayLike<number>, options: TermOptions): BrushTerm[] {
  const count = Math.floor(dabs.length / 3);
  const terms: BrushTerm[] = [];
  if (options.square) {
    if (options.joined && count > 1) {
      for (let i = 0; i + 1 < count; i++) terms.push({ kind: TERM.square, a: i, b: i + 1 });
    } else {
      for (let i = 0; i < count; i++) terms.push({ kind: TERM.square, a: i, b: i });
    }
    return terms;
  }
  if (!options.joined) {
    for (let i = 0; i < count; i++) terms.push({ kind: TERM.point, a: i, b: i });
    return terms;
  }
  if (count === 0) return terms;
  const distinct = (i: number, j: number) =>
    dabs[i * 3] !== dabs[j * 3] || dabs[i * 3 + 1] !== dabs[j * 3 + 1];
  const last = count - 1;
  let afterFirst = -1;
  for (let i = 1; i < count && afterFirst < 0; i++) if (distinct(i, 0)) afterFirst = i;
  let beforeLast = -1;
  for (let i = last - 1; i >= 0 && beforeLast < 0; i--) if (distinct(i, last)) beforeLast = i;
  if (afterFirst < 0 || beforeLast < 0) {
    if (options.ends) terms.push({ kind: TERM.point, a: last, b: last });
    return terms;
  }
  if (options.starts) terms.push({ kind: TERM.cap, a: 0, b: afterFirst });
  for (let i = 0; i + 1 < count; i++) {
    if (distinct(i, i + 1)) terms.push({ kind: TERM.segment, a: i, b: i + 1 });
  }
  if (options.ends) terms.push({ kind: TERM.cap, a: last, b: beforeLast });
  return terms;
}

/** How far past its radius an antialiased tip reaches: its rim fades over 1 px centred on it. */
export function tipPad(antialias: boolean): number {
  return antialias ? 0.5 : 0;
}

/**
 * How far from a dab of `diameter` a part can change pixels: the tip's reach, times the field's
 * influence for a round tip, with a pixel to spare.
 */
export function partRadius(diameter: number, antialias: boolean, square: boolean): number {
  const reach = diameter * 0.5 + tipPad(antialias);
  return square ? reach : reach * FIELD_INFLUENCE + 1;
}

/** The pixel box a part can change, clipped to the image. Undefined when empty. */
export function termBox(
  dabs: ArrayLike<number>,
  term: BrushTerm,
  antialias: boolean,
  square: boolean,
  width: number,
  height: number,
): { x0: number; y0: number; x1: number; y1: number } | undefined {
  const at = (i: number) => [dabs[i * 3] ?? 0, dabs[i * 3 + 1] ?? 0, dabs[i * 3 + 2] ?? 0] as const;
  const [ax, ay, ad] = at(term.a);
  const [bx, by, bd] =
    term.kind === TERM.segment || term.kind === TERM.square ? at(term.b) : at(term.a);
  const ra = partRadius(ad, antialias, square);
  const rb = partRadius(bd, antialias, square);
  const x0 = Math.max(0, Math.floor(Math.min(ax - ra, bx - rb)));
  const y0 = Math.max(0, Math.floor(Math.min(ay - ra, by - rb)));
  const x1 = Math.min(width, Math.ceil(Math.max(ax + ra, bx + rb)));
  const y1 = Math.min(height, Math.ceil(Math.max(ay + ra, by + rb)));
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : undefined;
}

/**
 * The reach of the full-pressure tip, which sets a round tip's 1 px rim ramp (`coverage_of`):
 * the size clamped as the Rust kernels clamp it (1 to 2000, NaN as 1).
 */
export function nominalReach(size: number, antialias: boolean): number {
  const clamped = Number.isNaN(size) ? 1 : Math.min(2000, Math.max(1, size));
  return Math.fround(Math.fround(clamped) * 0.5 + tipPad(antialias));
}

/** The hardness as the Rust kernels clamp it: 0 to 1, NaN as 0. */
export function clampHardness(hardness: number): number {
  return Number.isNaN(hardness) ? 0 : Math.min(1, Math.max(0, hardness));
}
