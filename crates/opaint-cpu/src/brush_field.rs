//! The coverage field of a round brush stroke (TL-BRUSH-01).
//!
//! A round stroke's coverage at a pixel is the tip's falloff at the pixel's distance from the
//! path. Measured as the plain nearest distance, that distance has a crease wherever two parts of
//! the path are equally near (the inside of any bend, corner, hairpin or crossing), and a soft
//! falloff shows the crease as a sharp line. So the distance is measured smoothly instead: as a
//! Gaussian-weighted average of the squared distances to every point of the path,
//!
//! `ρ² = ∫ d(s)² w(s) ds / ∫ w(s) ds − σ²`, with `w(s) = exp(−d(s)² / 2σ²)`,
//!
//! where distances are in units of the tip's reach and `σ` is [`FIELD_SIGMA`]. Along a straight
//! line the average is exactly `d² + σ²`, so `ρ` is the true distance and the cross-section is the
//! tip's falloff, whatever the polyline's segmentation (no ripple); along a circular arc it is
//! also exact to second order. Where two parts of the path are about equally near, their averages
//! blend smoothly. Each segment's two integrals are closed-form (`erfc`), and each end of the
//! stroke gets a cap that completes them to those of a round end, so the ends are the tip's round
//! ends. A single dab is the tip itself.
//!
//! The two integrals are kept per pixel in fixed point (`FIELD_ONE` = 1.0), so terms add up in any
//! order to the same values: a stroke added a few segments at a time matches the whole stroke.

/// σ of the weights, as a fraction of the tip's reach.
pub(crate) const FIELD_SIGMA: f32 = 0.3;
/// How far a term reaches, as a multiple of the tip's reach. Beyond it a term's weight is below
/// e^−11.7 ≈ 8·10⁻⁶ and is left out without moving any edge measurably.
pub(crate) const FIELD_INFLUENCE: f32 = 1.45;
/// The value 1 in fixed point.
pub(crate) const FIELD_ONE: f32 = 4_194_304.0;

/// A dab of a stroke: its centre and reach in image pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Node {
    pub x: f32,
    pub y: f32,
    pub reach: f32,
}

/// One additive part of a round stroke's field.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Term {
    /// The integrals along a segment.
    Segment(Node, Node),
    /// The cap at the stroke end `at`, whose path arrives from `from`.
    Cap { at: Node, from: Node },
    /// A single dab.
    Point(Node),
}

/// The field terms of `nodes`. Joined dabs are a polyline whose segments add up; `starts` and
/// `ends` say whether its first and last dab are the stroke's ends, which get caps. A joined
/// list of one dab is a single dab only when it ends the stroke. Spaced dabs are single dabs.
pub(crate) fn field_terms(nodes: &[Node], joined: bool, starts: bool, ends: bool) -> Vec<Term> {
    if !joined {
        return nodes.iter().map(|&n| Term::Point(n)).collect();
    }
    let distinct = |a: &Node, b: &Node| a.x != b.x || a.y != b.y;
    let mut terms = Vec::new();
    let (Some(&first), Some(&last)) = (nodes.first(), nodes.last()) else {
        return terms;
    };
    let after_first = nodes.iter().find(|n| distinct(n, &first)).copied();
    let before_last = nodes.iter().rev().find(|n| distinct(n, &last)).copied();
    let (Some(after_first), Some(before_last)) = (after_first, before_last) else {
        if ends {
            terms.push(Term::Point(last));
        }
        return terms;
    };
    if starts {
        terms.push(Term::Cap {
            at: first,
            from: after_first,
        });
    }
    for pair in nodes.windows(2) {
        if distinct(&pair[0], &pair[1]) {
            terms.push(Term::Segment(pair[0], pair[1]));
        }
    }
    if ends {
        terms.push(Term::Cap {
            at: last,
            from: before_last,
        });
    }
    terms
}

/// `exp(x)` for `x ≤ 0`, as `2ⁿ · eᵗ` with `n` the nearest integer to `x / ln 2`, `t = x − n ln 2`, and a
/// degree-6 Taylor polynomial for the rest (relative error below 2·10⁻⁷). It is faster than the
/// library's, and the WGSL twins evaluate the same operations, so both sides agree closely.
pub(crate) fn exp_neg(x: f32) -> f32 {
    let n = (x * std::f32::consts::LOG2_E + 0.5).floor();
    if n < -126.0 {
        return 0.0;
    }
    // x − n ln 2, with ln 2 split so that n × LN2_HI is exact (Cody and Waite).
    let t = (x - n * 0.693_145_75) - n * 1.428_606_8e-6;
    let p = 1.0
        + t * (1.0
            + t * (0.5
                + t * (1.0 / 6.0 + t * (1.0 / 24.0 + t * (1.0 / 120.0 + t * (1.0 / 720.0))))));
    p * f32::from_bits(((n as i32 + 127) as u32) << 23)
}

/// `erfc(x) · exp(x²)` for `x ≥ 0` (Abramowitz and Stegun 7.1.26, error below 1.5·10⁻⁷).
fn erfc_scaled(x: f32) -> f32 {
    let t = 1.0 / (1.0 + 0.327_591_1 * x);
    t * (0.254_829_6 + t * (-0.284_496_74 + t * (1.421_413_8 + t * (-1.453_152 + t * 1.061_405_4))))
}

/// `1 / 2σ²`, in units of the reach.
const K: f32 = 0.5 / (FIELD_SIGMA * FIELD_SIGMA);
/// `σ² / √(2π) σ`: the boundary term of `∫ t² w dt`.
const BOUNDARY: f32 =
    FIELD_SIGMA * std::f32::consts::FRAC_1_SQRT_2 * 0.5 * std::f32::consts::FRAC_2_SQRT_PI;
/// `1 / √2 σ`, which turns a distance along the path into the argument of `erfc`.
const INV_SCALE: f32 = 1.0 / (std::f32::consts::SQRT_2 * FIELD_SIGMA);

/// A term with the per-term quantities its per-pixel evaluation needs.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Prepared {
    term: Term,
    /// Segment: `b − a`, `1 / |b − a|²`, `|b − a|`, `1 / |b − a|` and the reach's change along it.
    /// Cap: the unit direction ahead of the end in `dx`, `dy`.
    dx: f32,
    dy: f32,
    inv_ll: f32,
    len: f32,
    inv_len: f32,
    dr: f32,
}

impl Prepared {
    pub(crate) fn new(term: Term) -> Self {
        let (dx, dy, dr) = match term {
            Term::Segment(a, b) => (b.x - a.x, b.y - a.y, b.reach - a.reach),
            Term::Cap { at, from } => (at.x - from.x, at.y - from.y, 0.0),
            Term::Point(_) => (0.0, 0.0, 0.0),
        };
        let ll = dx * dx + dy * dy;
        let len = ll.sqrt();
        let inv_len = 1.0 / len;
        let (dx, dy) = match term {
            Term::Cap { .. } => (dx * inv_len, dy * inv_len),
            _ => (dx, dy),
        };
        Prepared {
            term,
            dx,
            dy,
            inv_ll: 1.0 / ll,
            len,
            inv_len,
            dr,
        }
    }

    /// The weight integral `D` and the weighted squared-distance integral `N` of the term at pixel
    /// centre (`px`, `py`), in units of the term's reach, or zeros beyond its influence.
    pub(crate) fn value(&self, px: f32, py: f32) -> (f32, f32) {
        let s2 = FIELD_SIGMA * FIELD_SIGMA;
        match self.term {
            Term::Point(n) | Term::Cap { at: n, .. } => {
                let inv_r = 1.0 / n.reach;
                let (vx, vy) = ((px - n.x) * inv_r, (py - n.y) * inv_r);
                let r2 = vx * vx + vy * vy;
                if r2 > FIELD_INFLUENCE * FIELD_INFLUENCE {
                    return (0.0, 0.0);
                }
                let e = exp_neg(-r2 * K);
                if let Term::Point(_) = self.term {
                    return (e, (r2 + s2) * e);
                }
                // u: the distance ahead of the end, along the path's direction there.
                let u = vx * self.dx + vy * self.dy;
                let y2 = r2 - u * u;
                let half = 0.5 * erfc_scaled(u.abs() * INV_SCALE);
                if u <= 0.0 {
                    // Behind the end: the rest of the line the stroke would have gone on with.
                    let d = half * e;
                    (d, (y2 + s2) * d - BOUNDARY * u * e)
                } else {
                    // Ahead of the end: the end dab, less what the stroke's own line gives.
                    let n_end = (r2 + s2) - (y2 + s2) * half - BOUNDARY * u;
                    (e * (1.0 - half), e * n_end)
                }
            }
            Term::Segment(a, _) => {
                let (dx, dy) = (self.dx, self.dy);
                let (ex, ey) = (px - a.x, py - a.y);
                let along = ex * dx + ey * dy;
                let t = (along * self.inv_ll).clamp(0.0, 1.0);
                let reach = a.reach + t * self.dr;
                let (qx, qy) = (ex - t * dx, ey - t * dy);
                let limit = FIELD_INFLUENCE * reach;
                if qx * qx + qy * qy > limit * limit {
                    return (0.0, 0.0);
                }
                let inv_r = 1.0 / reach;
                let u = along * self.inv_len * inv_r;
                let h = (ex * dy - ey * dx) * self.inv_len * inv_r;
                let (t0, t1) = (-u, self.len * inv_r - u);
                let h2 = h * h;
                let ea = exp_neg(-(h2 + t0 * t0) * K);
                let eb = exp_neg(-(h2 + t1 * t1) * K);
                let (z0, z1) = (t0 * INV_SCALE, t1 * INV_SCALE);
                // (erf z1 − erf z0) / 2 · exp(−h² k), from erfc on the side that keeps it exact.
                let d = if z0 >= 0.0 {
                    0.5 * (erfc_scaled(z0) * ea - erfc_scaled(z1) * eb)
                } else if z1 <= 0.0 {
                    0.5 * (erfc_scaled(-z1) * eb - erfc_scaled(-z0) * ea)
                } else {
                    exp_neg(-h2 * K) - 0.5 * (erfc_scaled(-z0) * ea + erfc_scaled(z1) * eb)
                };
                (d, (h2 + s2) * d - BOUNDARY * (t1 * eb - t0 * ea))
            }
        }
    }

    /// The term's two integrals in fixed point.
    pub(crate) fn units(&self, px: f32, py: f32) -> (u32, u32) {
        let (d, n) = self.value(px, py);
        let fixed = |v: f32| (v.max(0.0) * FIELD_ONE + 0.5).floor() as u32;
        (fixed(d), fixed(n))
    }
}
/// The image-pixel box `[x0, x1) × [y0, y1)` the term can reach.
pub(crate) fn term_bounds(term: Term) -> (f32, f32, f32, f32) {
    let (a, b) = term_ends(term);
    let (ra, rb) = (FIELD_INFLUENCE * a.reach, FIELD_INFLUENCE * b.reach);
    (
        (a.x - ra).min(b.x - rb).floor(),
        (a.y - ra).min(b.y - rb).floor(),
        (a.x + ra).max(b.x + rb).ceil(),
        (a.y + ra).max(b.y + rb).ceil(),
    )
}

/// The segment a term spans (a single point for caps and dabs).
pub(crate) fn term_ends(term: Term) -> (Node, Node) {
    match term {
        Term::Segment(a, b) => (a, b),
        Term::Cap { at, .. } | Term::Point(at) => (at, at),
    }
}

/// The coverage (0 to 1) for a pixel's integrals: the tip's falloff at `ρ = √(N / D − σ²)`.
pub(crate) fn field_falloff(d: u32, n: u32, reach: f32, core: f32, antialias: bool) -> f32 {
    if d == 0 {
        return 0.0;
    }
    let rho2 = n as f32 / d as f32 - FIELD_SIGMA * FIELD_SIGMA;
    crate::brush::tip_falloff(rho2.max(0.0).sqrt(), reach, core, antialias)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(x: f32, y: f32) -> Node {
        Node { x, y, reach: 20.0 }
    }

    fn rho(terms: &[Term], px: f32, py: f32) -> f32 {
        let (d, n) = terms.iter().fold((0.0, 0.0), |(d, n), &t| {
            let (a, b) = Prepared::new(t).value(px, py);
            (d + a, n + b)
        });
        (n / d - FIELD_SIGMA * FIELD_SIGMA).max(0.0).sqrt()
    }

    #[test]
    fn the_fast_exponential_matches_the_library() {
        for i in 0..2000 {
            let x = -(i as f32) * 0.05;
            let (got, want) = (exp_neg(x), x.exp());
            assert!(
                (got - want).abs() <= want * 2e-7 + 1e-37,
                "{x}: {got} vs {want}"
            );
        }
        assert_eq!(exp_neg(-200.0), 0.0);
    }

    #[test]
    fn erfc_matches_reference_values() {
        for (x, erfc) in [
            (0.0f32, 1.0f32),
            (0.5, 0.479_500_1),
            (1.0, 0.157_299_2),
            (2.0, 0.004_677_735),
        ] {
            assert!((erfc_scaled(x) * (-x * x).exp() - erfc).abs() < 2e-7, "{x}");
        }
    }

    #[test]
    fn a_long_straight_line_measures_the_true_distance() {
        let terms = [Term::Segment(node(0.0, 0.0), node(400.0, 0.0))];
        for y in [0.0f32, 3.0, 7.5, 12.0, 19.0, 25.0] {
            let got = rho(&terms, 200.0, y) * 20.0;
            assert!((got - y).abs() < 2e-3, "{y}: {got}");
        }
    }

    #[test]
    fn segments_and_caps_measure_the_distance_to_a_capsule() {
        let (a, b, c) = (node(0.0, 0.0), node(60.0, 0.0), node(100.0, 0.0));
        let terms = field_terms(&[a, b, c], true, true, true);
        assert_eq!(terms.len(), 4);
        for (px, py) in [
            (100.0f32, 0.0f32),
            (108.0, 4.0),
            (-6.0, -9.0),
            (50.0, 11.0),
            (-15.0, 0.0),
            (112.0, -13.0),
        ] {
            let dx = (px - 100.0).max(-px).max(0.0);
            let expected = (dx * dx + py * py).sqrt();
            let got = rho(&terms, px, py) * 20.0;
            assert!(
                (got - expected).abs() < 5e-3,
                "({px}, {py}): {got} vs {expected}"
            );
        }
    }

    #[test]
    fn a_lone_dab_counts_only_when_it_ends_the_stroke() {
        let n = node(5.0, 5.0);
        assert_eq!(field_terms(&[n], true, true, true), vec![Term::Point(n)]);
        assert!(field_terms(&[n], true, true, false).is_empty());
        assert_eq!(field_terms(&[n, n], false, false, false).len(), 2);
        let got = rho(&[Term::Point(n)], 11.0, 13.0) * 20.0;
        assert!((got - 10.0).abs() < 1e-3, "{got}");
    }
}
