//! Brush engine (TL-BRUSH-01, TL-OPT-BRUSH, TL-OPT-AA, TL-OPT-BLEND, TL-OPT-SMOOTH).
//!
//! This is the reference for the WebGPU brush twins. The dab list is computed here and shared with
//! the GPU paths, and the WGSL evaluates the same coverage, so both shape every stroke
//! identically. Pixels are straight-alpha RGBA8, as everywhere else in the crate.
//!
//! With a spacing below [`JOINED_SPACING`], consecutive dabs are joined: the stroke's coverage at a
//! pixel is the tip's falloff at its distance from the path, the tip moving continuously from one
//! dab to the next. The edge is then smooth along the stroke whatever the spacing, with no
//! scallops between dabs. A round tip measures a soft distance that also stays smooth on the
//! inside of bends (see [`crate::brush_field`]); a square tip keeps its crisp swept outline. With
//! a larger spacing the dabs are stamped apart, as separate tips.

use crate::blend::{composite_pixel, mul, BlendMode};
use crate::brush_field::{
    field_falloff, field_terms, term_bounds, term_ends, Node, Prepared, Term, FIELD_INFLUENCE,
};
use wasm_bindgen::prelude::*;

/// Blend value that replaces the destination, alpha included (TL-OPT-BLEND "Overwrite"). Values
/// 0-13 are the layer blend modes of [`BlendMode`].
pub const OVERWRITE: u8 = 14;
/// Spacing (a fraction of the diameter) from which the dabs are stamped apart instead of joined.
pub const JOINED_SPACING: f32 = 1.0;
const MIN_SIZE: f32 = 1.0;
const MAX_SIZE: f32 = 2000.0;
const MIN_SPACING: f32 = 0.01;
const MAX_SPACING: f32 = 5.0;

/// The number of hatch patterns (TL-OPT-FILL).
pub const HATCH_COUNT: u8 = 8;

/// The 8 × 8 hatch tiles of TL-OPT-FILL, in the order Horizontal, Vertical, Forward Diagonal,
/// Backward Diagonal, Cross, Diagonal Cross, 50 Percent and Dotted Grid. Each row is one byte with
/// its leftmost pixel in bit 7, and a set bit takes the foreground color. The tiles repeat from the
/// canvas origin.
pub const HATCH_PATTERNS: [[u8; 8]; 8] = [
    [0xFF, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00, 0x00],
    [0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88],
    [0x88, 0x11, 0x22, 0x44, 0x88, 0x11, 0x22, 0x44],
    [0x88, 0x44, 0x22, 0x11, 0x88, 0x44, 0x22, 0x11],
    [0xFF, 0x88, 0x88, 0x88, 0xFF, 0x88, 0x88, 0x88],
    [0x88, 0x55, 0x22, 0x55, 0x88, 0x55, 0x22, 0x55],
    [0xAA, 0x55, 0xAA, 0x55, 0xAA, 0x55, 0xAA, 0x55],
    [0x88, 0x00, 0x00, 0x00, 0x88, 0x00, 0x00, 0x00],
];

/// Whether the hatch pattern `style` (1 to 8) sets the pixel at (`x`, `y`).
fn hatch_bit(style: u8, x: usize, y: usize) -> bool {
    let row = HATCH_PATTERNS[usize::from(style - 1)][y % 8];
    (row >> (7 - x % 8)) & 1 == 1
}

/// One pointer sample: a position in canvas pixels and pen pressure in 0..=1 (1 for mouse input).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StrokePoint {
    pub x: f32,
    pub y: f32,
    pub pressure: f32,
}

/// One stamp of the tip: its center and diameter in canvas pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Dab {
    pub x: f32,
    pub y: f32,
    pub diameter: f32,
}

/// Tool-option values for one stroke. Sizes are in pixels and spacing is a fraction of the tip
/// diameter. Values outside their range are clamped (TL-OPT-BRUSH).
#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BrushSettings {
    /// Tip diameter at full pressure, 1..=2000.
    pub size: f32,
    /// Hardness 0..=1 (TL-OPT-BRUSH "Hardness"): the fraction of the tip's radius that is solid
    /// (see `tip_falloff`). Ignored, and treated as 1, when `antialias` is off.
    pub hardness: f32,
    /// Spacing as a fraction of the tip diameter, 0.01..=5. Below [`JOINED_SPACING`] the tip is
    /// swept continuously and the spacing has no effect; from it on, dabs are stamped this far apart.
    pub spacing: f32,
    /// Square tip instead of a circle.
    pub square: bool,
    /// Centripetal Catmull-Rom path smoothing (TL-OPT-SMOOTH).
    pub smooth: bool,
    /// Antialiased rendering (TL-OPT-AA). Off forces hardness to 1 and samples the tip without
    /// filtering.
    pub antialias: bool,
    /// Pressure changes the tip size (TL-BRUSH-01). Off uses full pressure.
    pub pressure: bool,
    /// Erase the destination's alpha instead of painting (TL-BRUSH-ER-01).
    pub erase: bool,
    /// Blend mode 0-13 (`BlendMode`) or [`OVERWRITE`] (14).
    pub blend: u8,
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
    /// Hatch fill (TL-OPT-FILL): 0 for a solid color, or 1 to 8 for one of [`HATCH_PATTERNS`] in
    /// that order. Set bits paint `r, g, b, a` and clear bits paint `back_*`.
    pub hatch: u8,
    pub back_r: u8,
    pub back_g: u8,
    pub back_b: u8,
    pub back_a: u8,
}

impl Default for BrushSettings {
    /// The factory values of TL-OPT-BRUSH and TL-OPT-AA, black at full alpha.
    fn default() -> Self {
        Self {
            size: 2.0,
            hardness: 0.75,
            spacing: 0.15,
            square: false,
            smooth: true,
            antialias: true,
            pressure: true,
            erase: false,
            blend: BlendMode::Normal as u8,
            r: 0,
            g: 0,
            b: 0,
            a: 255,
            hatch: 0,
            back_r: 255,
            back_g: 255,
            back_b: 255,
            back_a: 255,
        }
    }
}

#[wasm_bindgen]
impl BrushSettings {
    #[wasm_bindgen(constructor)]
    pub fn new() -> BrushSettings {
        Self::default()
    }
}

impl BrushSettings {
    /// The settings with every numeric value clamped to its range. NaN becomes the lower bound.
    fn normalized(self) -> Self {
        Self {
            size: finite_clamp(self.size, MIN_SIZE, MAX_SIZE),
            hardness: finite_clamp(self.hardness, 0.0, 1.0),
            spacing: finite_clamp(self.spacing, MIN_SPACING, MAX_SPACING),
            ..self
        }
    }
}

/// How a dab's coverage is applied to the destination pixel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Paint {
    Erase,
    Overwrite,
    Blend(BlendMode),
}

fn paint_of(brush: &BrushSettings) -> Result<Paint, String> {
    if brush.erase {
        return Ok(Paint::Erase);
    }
    paint_for(brush.blend)
}

/// The paint for a blend value: 0-13 are the layer blend modes and [`OVERWRITE`] replaces.
pub(crate) fn paint_for(blend: u8) -> Result<Paint, String> {
    match blend {
        OVERWRITE => Ok(Paint::Overwrite),
        value => BlendMode::try_from(value)
            .map(Paint::Blend)
            .map_err(|value| format!("unknown blend mode {value}")),
    }
}

fn finite_clamp(value: f32, low: f32, high: f32) -> f32 {
    if value.is_nan() {
        low
    } else {
        value.clamp(low, high)
    }
}

/// Tip diameter for one pressure: `d × max(p, 1/d)` (TL-BRUSH-01), so it is never below 1 px.
fn diameter_at(brush: &BrushSettings, pressure: f32) -> f32 {
    let p = if brush.pressure {
        finite_clamp(pressure, 0.0, 1.0)
    } else {
        1.0
    };
    brush.size * p.max(1.0 / brush.size)
}

/// Drops consecutive duplicate positions and, when `smooth`, resamples the path along a
/// centripetal Catmull-Rom spline (TL-BRUSH-01). Pressure is interpolated with the same spline.
/// The spline passes through every input sample.
pub fn stroke_path(points: &[StrokePoint], smooth: bool) -> Vec<StrokePoint> {
    let mut unique: Vec<StrokePoint> = Vec::with_capacity(points.len());
    for &point in points {
        if unique
            .last()
            .is_none_or(|last| last.x != point.x || last.y != point.y)
        {
            unique.push(point);
        }
    }
    if !smooth || unique.len() < 2 {
        return unique;
    }
    spline(&unique)
}

type Vec3 = [f64; 3];

fn point3(p: StrokePoint) -> Vec3 {
    [f64::from(p.x), f64::from(p.y), f64::from(p.pressure)]
}

fn blend3(a: Vec3, b: Vec3, wa: f64, wb: f64) -> Vec3 {
    [
        a[0] * wa + b[0] * wb,
        a[1] * wa + b[1] * wb,
        a[2] * wa + b[2] * wb,
    ]
}

fn distance(a: Vec3, b: Vec3) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
}

/// Samples the centripetal (alpha 0.5) Catmull-Rom spline through `points`, at least two of them.
/// The ends are extended by reflection so the first and last segments have phantom neighbors.
fn spline(points: &[StrokePoint]) -> Vec<StrokePoint> {
    let n = points.len();
    let mut out = Vec::new();
    for k in 0..n - 1 {
        spline_segment(points, k, |p| out.push(p));
    }
    out.push(points[n - 1]);
    out
}

/// Samples segment `k` of the spline through `points` (from `points[k]` towards `points[k + 1]`,
/// excluding the end), at least two points. The segment depends on `points[k - 1..=k + 2]`, with
/// reflected phantom points past either end.
fn spline_segment(points: &[StrokePoint], k: usize, mut emit: impl FnMut(StrokePoint)) {
    let n = points.len();
    let at = |i: isize| -> Vec3 {
        if i < 0 {
            blend3(point3(points[0]), point3(points[1]), 2.0, -1.0)
        } else if (i as usize) >= n {
            blend3(point3(points[n - 1]), point3(points[n - 2]), 2.0, -1.0)
        } else {
            point3(points[i as usize])
        }
    };
    let k = k as isize;
    let (p0, p1, p2, p3) = (at(k - 1), at(k), at(k + 1), at(k + 2));
    let t1 = distance(p0, p1).sqrt();
    let t2 = t1 + distance(p1, p2).sqrt();
    let t3 = t2 + distance(p2, p3).sqrt();
    let steps = (distance(p1, p2).ceil() as usize).max(1);
    for i in 0..steps {
        let t = t1 + (t2 - t1) * (i as f64 / steps as f64);
        let c = barry_goldman(p0, p1, p2, p3, [0.0, t1, t2, t3], t);
        emit(StrokePoint {
            x: c[0] as f32,
            y: c[1] as f32,
            pressure: c[2] as f32,
        });
    }
}

/// Evaluates one segment of the spline between `p1` and `p2` at parameter `t` (Barry and Goldman).
fn barry_goldman(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, knots: [f64; 4], t: f64) -> Vec3 {
    let [t0, t1, t2, t3] = knots;
    let a1 = blend3(p0, p1, (t1 - t) / (t1 - t0), (t - t0) / (t1 - t0));
    let a2 = blend3(p1, p2, (t2 - t) / (t2 - t1), (t - t1) / (t2 - t1));
    let a3 = blend3(p2, p3, (t3 - t) / (t3 - t2), (t - t2) / (t3 - t2));
    let b1 = blend3(a1, a2, (t2 - t) / (t2 - t0), (t - t0) / (t2 - t0));
    let b2 = blend3(a2, a3, (t3 - t) / (t3 - t1), (t - t1) / (t3 - t1));
    blend3(b1, b2, (t2 - t) / (t2 - t1), (t - t1) / (t2 - t1))
}

/// Places the dabs along the (smoothed) path (TL-BRUSH-01).
///
/// With a spacing of [`JOINED_SPACING`] or more, the first dab sits on the first sample and each
/// next dab is `spacing × diameter` further along the path, measured as Euclidean arc length, with
/// the diameter taken at the pressure of the dab's own position.
///
/// With a smaller spacing the dabs are the corners of a polyline that follows the path within a
/// small tolerance, and the tip is swept along it, so the spacing doesn't change the result. Path
/// points that lie on a nearly straight run with a nearly linear pressure are merged into one
/// segment, which keeps the number of segments, and the work, low.
pub fn plan_dabs(points: &[StrokePoint], brush: &BrushSettings) -> Vec<Dab> {
    let brush = brush.normalized();
    let mut placer = Placer::new(brush);
    let mut flat = Vec::new();
    for p in stroke_path(points, brush.smooth) {
        placer.place(p, &mut flat);
    }
    placer.finish(&mut flat);
    flat.as_chunks::<3>()
        .0
        .iter()
        .map(|d| Dab {
            x: d[0],
            y: d[1],
            diameter: d[2],
        })
        .collect()
}

/// Whether the brush joins consecutive dabs into a swept tip (spacing below [`JOINED_SPACING`]).
pub fn joins_dabs(brush: &BrushSettings) -> bool {
    brush.normalized().spacing < JOINED_SPACING
}

/// How far, in pixels, the tip of `diameter` can cover: its radius, and half a pixel more when
/// antialiased, where the rim's 1 px ramp ends.
fn reach_of(diameter: f32, antialias: bool) -> f32 {
    diameter * 0.5 + if antialias { 0.5 } else { 0.0 }
}

/// The soft part of the tip's falloff over `x` from 0 (the hard core's edge) to 1 (the reach):
/// `(1 − x²)²`, flat at the core and reaching zero with zero slope at the edge, with its 50 %
/// point at 0.54 of the ramp, so a soft tip feathers over nearly its whole radius. Being a
/// polynomial, the WGSL twins evaluate it exactly as here.
fn soft_falloff(x: f32) -> f32 {
    let u = 1.0 - x * x;
    u * u
}

/// The solid core of the tip as a fraction of its reach (TL-OPT-BRUSH Hardness): the square of
/// the hardness, so that high hardness still leaves a visible soft edge (75 % keeps a solid 56 %
/// and feathers the outer 44 %). Aliased tips are solid.
fn core_of(brush: &BrushSettings) -> f32 {
    if brush.antialias {
        brush.hardness * brush.hardness
    } else {
        1.0
    }
}

/// The coverage of a tip at `rho`, the distance from its centre over its reach: solid inside the
/// `core` fraction, then [`soft_falloff`] to zero at the reach. An antialiased tip also fades over
/// its last pixel, so a hard edge has a 1 px ramp centred on the radius. Aliased tips are solid
/// inside their radius.
pub(crate) fn tip_falloff(rho: f32, reach: f32, core: f32, antialias: bool) -> f32 {
    if rho >= 1.0 {
        return 0.0;
    }
    if !antialias {
        return 1.0;
    }
    let rim = ((1.0 - rho) * reach).min(1.0);
    if rho <= core {
        return rim;
    }
    soft_falloff((rho - core) / (1.0 - core)) * rim
}

/// The smallest `axis distance / reach` from pixel centre (`px`, `py`) to a square tip swept from
/// `a` to `b`, with the reach growing linearly along the segment, and the reach where it is
/// smallest. It is exact: the ratio is smallest at an end of the segment or where the axis
/// distances cross or vanish.
fn square_ratio(px: f32, py: f32, a: Node, b: Node) -> (f32, f32) {
    let (ex, ey) = (px - a.x, py - a.y);
    let (dx, dy, dr) = (b.x - a.x, b.y - a.y, b.reach - a.reach);
    let ratio = |t: f32| {
        let (qx, qy) = (ex - t * dx, ey - t * dy);
        let r = a.reach + t * dr;
        (qx.abs().max(qy.abs()) / r, r)
    };
    let mut best = ratio(0.0);
    let mut consider = |t: f32| {
        if t > 0.0 && t <= 1.0 {
            let candidate = ratio(t);
            if candidate.0 < best.0 {
                best = candidate;
            }
        }
    };
    consider(1.0);
    if dx != 0.0 {
        consider(ex / dx);
    }
    if dy != 0.0 {
        consider(ey / dy);
    }
    if dx != dy {
        consider((ex - ey) / (dx - dy));
    }
    if dx != -dy {
        consider((ex + ey) / (dx + dy));
    }
    best
}

/// The range of `px` with `k × px + c ≥ m`, or `None` when no `px` qualifies.
fn half_line(k: f64, c: f64, m: f64) -> Option<(f64, f64)> {
    if k > 0.0 {
        Some(((m - c) / k, f64::INFINITY))
    } else if k < 0.0 {
        Some((f64::NEG_INFINITY, (m - c) / k))
    } else {
        (c >= m).then_some((f64::NEG_INFINITY, f64::INFINITY))
    }
}

/// Calls `visit(x, y, px, py)` for each pixel of a `width` × `height` buffer, whose top-left pixel
/// is image pixel `origin`, within `radius_a` of `a` or `radius_b` of `b` along the box they span,
/// and within `band` of the line through them: `x`, `y` in the buffer, `px`, `py` the pixel
/// centre in the image. Each row visits only its span inside the band, so the work follows the
/// segment's area rather than its bounding box. With `round`, each row is also kept to the
/// capsule of the two discs and the band between them (a pixel to spare).
#[allow(clippy::too_many_arguments)]
fn for_each_pixel(
    a: Node,
    b: Node,
    radius_a: f32,
    radius_b: f32,
    band: f32,
    round: bool,
    width: usize,
    height: usize,
    origin: (usize, usize),
    mut visit: impl FnMut(usize, usize, f32, f32),
) {
    let low_x = f64::from((a.x - radius_a).min(b.x - radius_b).floor());
    let high_x = f64::from((a.x + radius_a).max(b.x + radius_b).ceil());
    let low_y = f64::from((a.y - radius_a).min(b.y - radius_b).floor());
    let high_y = f64::from((a.y + radius_a).max(b.y + radius_b).ceil());
    let (ox, oy) = (origin.0 as f64, origin.1 as f64);
    let rows = (low_y.max(oy), high_y.min(oy + height as f64));
    if rows.0 >= rows.1 {
        return;
    }
    let (ax, ay) = (f64::from(a.x), f64::from(a.y));
    let (dx, dy) = (f64::from(b.x) - ax, f64::from(b.y) - ay);
    let length = (dx * dx + dy * dy).sqrt();
    // |cross| ≤ band, with the cross product scaled by the length and a pixel to spare.
    let band = f64::from(band) * length + length;
    for y in rows.0 as usize..rows.1 as usize {
        let py = y as f64 + 0.5;
        let (mut first, mut last) = (low_x, high_x - 1.0);
        // Keeps the pixel centres x + 0.5 with k × (x + 0.5) + c ≥ m, a pixel wider each way.
        let mut keep = |k: f64, c: f64, m: f64| {
            if k > 0.0 {
                first = first.max(((m - c) / k - 0.5).ceil() - 1.0);
            } else if k < 0.0 {
                last = last.min(((m - c) / k - 0.5).floor() + 1.0);
            } else if c < m {
                last = first - 1.0;
            }
        };
        if length > 1e-3 {
            let cross = -ax * dy - (py - ay) * dx;
            keep(dy, cross, -band);
            keep(-dy, -cross, -band);
        }
        if round {
            let (low, high) = capsule_row(a, b, radius_a, radius_b, py);
            if low > high {
                continue;
            }
            first = first.max((low - 0.5).ceil() - 1.0);
            last = last.min((high - 0.5).floor() + 1.0);
        }
        let first = first.max(ox);
        let last = last.min(ox + width as f64 - 1.0);
        if first > last {
            continue;
        }
        let pyf = py as f32;
        for x in first as usize..=last as usize {
            visit(x - origin.0, y - origin.1, x as f32 + 0.5, pyf);
        }
    }
}

/// The range of pixel centres on row `py` within `radius_a` of `a`, `radius_b` of `b`, or the
/// larger radius of the segment between them: empty (low > high) when the row misses them.
fn capsule_row(a: Node, b: Node, radius_a: f32, radius_b: f32, py: f64) -> (f64, f64) {
    let (mut low, mut high) = (f64::INFINITY, f64::NEG_INFINITY);
    let mut add = |range: Option<(f64, f64)>| {
        if let Some((l, h)) = range {
            if l <= h {
                low = low.min(l);
                high = high.max(h);
            }
        }
    };
    let disc = |n: Node, r: f32| {
        let (r, d) = (f64::from(r), py - f64::from(n.y));
        let w = r * r - d * d;
        (w >= 0.0).then(|| (f64::from(n.x) - w.sqrt(), f64::from(n.x) + w.sqrt()))
    };
    add(disc(a, radius_a));
    add(disc(b, radius_b));
    let (ax, ay) = (f64::from(a.x), f64::from(a.y));
    let (dx, dy) = (f64::from(b.x) - ax, f64::from(b.y) - ay);
    let ll = dx * dx + dy * dy;
    if ll > 1e-6 {
        let r = f64::from(radius_a.max(radius_b)) * ll.sqrt();
        // The band |cross| ≤ r · L and the slab 0 ≤ along ≤ L², each as a range of px.
        let cross = -ax * dy - (py - ay) * dx;
        let along = -ax * dx + (py - ay) * dy;
        let ranges = [
            half_line(dy, cross, -r),
            half_line(-dy, -cross, -r),
            half_line(dx, along, 0.0),
            half_line(-dx, -along, -ll),
        ];
        let mut slab = Some((f64::NEG_INFINITY, f64::INFINITY));
        for range in ranges {
            slab = match (slab, range) {
                (Some((l, h)), Some((rl, rh))) => Some((l.max(rl), h.min(rh))),
                _ => None,
            };
        }
        add(slab);
    }
    (low, high)
}

/// One part of a stroke's coverage: a field term of a round tip, which adds up, or a square tip
/// swept from one dab to another, whose coverage the stroke keeps the largest of.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Mark {
    Field(Term),
    Square(Node, Node),
}

/// The marks of `dabs` (flat `x, y, diameter` triples). Joined dabs make a polyline; `starts` and
/// `ends` say whether its first and last dab are the ends of the stroke (see [`field_terms`]).
fn marks(
    dabs: &[f32],
    brush: &BrushSettings,
    starts: bool,
    ends: bool,
) -> Result<Vec<Mark>, String> {
    if !dabs.len().is_multiple_of(3) {
        return Err("dabs must be x, y, diameter triples".to_owned());
    }
    let nodes: Vec<Node> = dabs
        .as_chunks::<3>()
        .0
        .iter()
        .map(|d| Node {
            x: d[0],
            y: d[1],
            reach: reach_of(d[2], brush.antialias),
        })
        .collect();
    let joined = brush.spacing < JOINED_SPACING;
    if !brush.square {
        let terms = field_terms(&nodes, joined, starts, ends);
        return Ok(terms.into_iter().map(Mark::Field).collect());
    }
    Ok(if joined && nodes.len() > 1 {
        nodes.windows(2).map(|w| Mark::Square(w[0], w[1])).collect()
    } else {
        nodes.iter().map(|&n| Mark::Square(n, n)).collect()
    })
}

/// The image-pixel box `[x0, x1) × [y0, y1)` a mark can change.
fn mark_bounds(mark: Mark) -> (f32, f32, f32, f32) {
    match mark {
        Mark::Field(term) => term_bounds(term),
        Mark::Square(a, b) => (
            (a.x - a.reach).min(b.x - b.reach).floor(),
            (a.y - a.reach).min(b.y - b.reach).floor(),
            (a.x + a.reach).max(b.x + b.reach).ceil(),
            (a.y + a.reach).max(b.y + b.reach).ceil(),
        ),
    }
}

/// Adds a mark to the stroke's per-pixel values, two words per pixel: a field term adds its two
/// fixed-point integrals, a swept square raises the first word to its 8-bit coverage.
fn apply_mark(
    values: &mut [u32],
    width: usize,
    height: usize,
    origin: (usize, usize),
    mark: Mark,
    brush: &BrushSettings,
) {
    match mark {
        Mark::Field(term) => {
            let (a, b) = term_ends(term);
            let (ra, rb) = (FIELD_INFLUENCE * a.reach, FIELD_INFLUENCE * b.reach);
            let prepared = Prepared::new(term);
            for_each_pixel(
                a,
                b,
                ra,
                rb,
                ra.max(rb),
                true,
                width,
                height,
                origin,
                |x, y, px, py| {
                    let (d, n) = prepared.units(px, py);
                    if d != 0 || n != 0 {
                        let i = (y * width + x) * 2;
                        values[i] = values[i].saturating_add(d);
                        values[i + 1] = values[i + 1].saturating_add(n);
                    }
                },
            );
        }
        Mark::Square(a, b) => {
            let core = core_of(brush);
            let band = a.reach.max(b.reach) * std::f32::consts::SQRT_2;
            for_each_pixel(
                a,
                b,
                a.reach,
                b.reach,
                band,
                false,
                width,
                height,
                origin,
                |x, y, px, py| {
                    let (rho, reach) = square_ratio(px, py, a, b);
                    let c = (tip_falloff(rho, reach, core, brush.antialias) * 255.0 + 0.5).floor()
                        as u32;
                    let cell = &mut values[(y * width + x) * 2];
                    *cell = (*cell).max(c);
                },
            );
        }
    }
}

/// The 8-bit coverage of a pixel's two words: a round tip's field through the tip's falloff (with
/// the reach of the full-pressure tip for the rim's ramp), a square tip's coverage as it is.
fn coverage_of(value: [u32; 2], brush: &BrushSettings) -> u32 {
    if brush.square {
        return value[0].min(255);
    }
    let reach = reach_of(brush.size, brush.antialias);
    let falloff = field_falloff(value[0], value[1], reach, core_of(brush), brush.antialias);
    (falloff * 255.0 + 0.5).floor() as u32
}

/// The two words of pixel `i`.
fn pair(values: &[u32], i: usize) -> [u32; 2] {
    [values[i * 2], values[i * 2 + 1]]
}

/// Places the dabs of a stroke as its path points arrive, for [`plan_dabs`] and [`DabPlanner`].
#[derive(Clone, Debug)]
struct Placer {
    brush: BrushSettings,
    joined: bool,
    /// The last path point placed.
    last: Option<StrokePoint>,
    /// Spaced dabs: arc length of the next dab, and of `last`, along the path.
    next: f64,
    start: f64,
    /// Joined dabs: the last dab placed, and the run of path points that may still merge into the
    /// segment from it.
    anchor: Option<Dab>,
    run: Option<Run>,
    /// How far, in pixels, a merged segment may stray from the path points it replaces.
    tolerance: f32,
}

/// Path points that one segment from the anchor to `end` can replace: every point so far lies
/// within the tolerance of it. Each point narrows the directions (relative to `heading`) and the
/// diameter slopes (per pixel from the anchor) that a longer segment may take.
#[derive(Clone, Copy, Debug)]
struct Run {
    end: Dab,
    heading: f32,
    low: f32,
    high: f32,
    slope_low: f32,
    slope_high: f32,
    /// The largest distance of a point from the anchor.
    far: f32,
}

impl Placer {
    fn new(brush: BrushSettings) -> Self {
        Placer {
            brush,
            joined: brush.spacing < JOINED_SPACING,
            last: None,
            next: 0.0,
            start: 0.0,
            anchor: None,
            run: None,
            tolerance: if brush.square {
                (brush.size / 2000.0).max(0.01)
            } else {
                (brush.size * 0.005).max(0.01)
            },
        }
    }

    /// Extends the path to `p` and places the dabs that became final.
    fn place(&mut self, p: StrokePoint, out: &mut Vec<f32>) {
        if self.joined {
            self.place_joined(p, out);
        } else {
            self.place_spaced(p, out);
        }
    }

    /// Places the dabs that wait for more of the path.
    fn finish(&mut self, out: &mut Vec<f32>) {
        if let Some(run) = self.run.take() {
            self.emit(run.end, out);
        }
    }

    fn place_spaced(&mut self, p: StrokePoint, out: &mut Vec<f32>) {
        let brush = self.brush;
        let Some(a) = self.last else {
            let diameter = diameter_at(&brush, p.pressure);
            out.extend([p.x, p.y, diameter]);
            self.next = f64::from(brush.spacing * diameter);
            self.start = 0.0;
            self.last = Some(p);
            return;
        };
        let len = distance(point3(a), point3(p));
        while self.next <= self.start + len {
            let t = ((self.next - self.start) / len) as f32;
            let x = a.x + (p.x - a.x) * t;
            let y = a.y + (p.y - a.y) * t;
            let diameter = diameter_at(&brush, a.pressure + (p.pressure - a.pressure) * t);
            out.extend([x, y, diameter]);
            self.next += f64::from(brush.spacing * diameter);
        }
        self.start += len;
        self.last = Some(p);
    }

    /// The longest segment for two diameters: twice the smaller one, and at least 4 px, so that a
    /// segment's bounding box stays close to the area its tip sweeps.
    fn longest(a: f32, b: f32) -> f32 {
        (2.0 * a.min(b)).max(4.0)
    }

    fn place_joined(&mut self, p: StrokePoint, out: &mut Vec<f32>) {
        let brush = self.brush;
        let dab = |p: StrokePoint| Dab {
            x: p.x,
            y: p.y,
            diameter: diameter_at(&brush, p.pressure),
        };
        let Some(a) = self.last else {
            self.last = Some(p);
            self.emit(dab(p), out);
            return;
        };
        // A long step of the path is split, so no segment is much longer than its tip is wide.
        let longest = Self::longest(dab(a).diameter, dab(p).diameter);
        let steps = (distance(point3(a), point3(p)) / f64::from(longest))
            .ceil()
            .max(1.0) as u32;
        for i in 1..=steps {
            let q = if i == steps {
                p
            } else {
                let t = i as f32 / steps as f32;
                StrokePoint {
                    x: a.x + (p.x - a.x) * t,
                    y: a.y + (p.y - a.y) * t,
                    pressure: a.pressure + (p.pressure - a.pressure) * t,
                }
            };
            self.add(dab(q), out);
        }
        self.last = Some(p);
    }

    /// Adds a path point to the run from the anchor, or ends the run's segment before it.
    fn add(&mut self, q: Dab, out: &mut Vec<f32>) {
        let Some(a) = self.anchor else {
            self.emit(q, out);
            return;
        };
        let (vx, vy) = (q.x - a.x, q.y - a.y);
        let rho = (vx * vx + vy * vy).sqrt();
        let tol = self.tolerance;
        let Some(run) = self.run else {
            if rho == 0.0 {
                if q.diameter != a.diameter {
                    self.emit(q, out);
                }
                return;
            }
            let spread = if rho <= tol {
                std::f32::consts::PI
            } else {
                (tol / rho).asin()
            };
            self.run = Some(Run {
                end: q,
                heading: vy.atan2(vx),
                low: -spread,
                high: spread,
                slope_low: (q.diameter - tol - a.diameter) / rho,
                slope_high: (q.diameter + tol - a.diameter) / rho,
                far: rho,
            });
            return;
        };
        let mut angle = vy.atan2(vx) - run.heading;
        if angle > std::f32::consts::PI {
            angle -= std::f32::consts::TAU;
        } else if angle < -std::f32::consts::PI {
            angle += std::f32::consts::TAU;
        }
        let slope = if rho > 0.0 {
            (q.diameter - a.diameter) / rho
        } else {
            f32::NAN
        };
        let fits = rho >= run.far - tol
            && rho <= Self::longest(a.diameter, q.diameter)
            && angle >= run.low
            && angle <= run.high
            && slope >= run.slope_low
            && slope <= run.slope_high;
        if !fits {
            self.run = None;
            self.emit(run.end, out);
            self.add(q, out);
            return;
        }
        let spread = if rho <= tol {
            std::f32::consts::PI
        } else {
            (tol / rho).asin()
        };
        self.run = Some(Run {
            end: q,
            low: run.low.max(angle - spread),
            high: run.high.min(angle + spread),
            slope_low: run.slope_low.max((q.diameter - tol - a.diameter) / rho),
            slope_high: run.slope_high.min((q.diameter + tol - a.diameter) / rho),
            far: run.far.max(rho),
            ..run
        });
    }

    fn emit(&mut self, d: Dab, out: &mut Vec<f32>) {
        out.extend([d.x, d.y, d.diameter]);
        self.anchor = Some(d);
    }
}

/// The straight RGBA color that paints the pixel (`x`, `y`): the brush color, or with a hatch the
/// foreground or background by the pattern bit.
pub(crate) fn source_at(brush: &BrushSettings, x: usize, y: usize) -> [u8; 4] {
    if brush.hatch == 0 || hatch_bit(brush.hatch, x, y) {
        [brush.r, brush.g, brush.b, brush.a]
    } else {
        [brush.back_r, brush.back_g, brush.back_b, brush.back_a]
    }
}

/// Applies one 8-bit coverage `c` of the straight color `src` to a destination pixel.
pub(crate) fn paint_pixel(d: [u8; 4], c: u32, src: [u8; 4], paint: Paint) -> [u8; 4] {
    let d = d.map(u32::from);
    let out = match paint {
        Paint::Erase => [d[0], d[1], d[2], mul(d[3], 255 - c)],
        Paint::Overwrite => {
            let s = src.map(u32::from);
            std::array::from_fn(|i| (mul(d[i], 255 - c) + mul(s[i], c)).min(255))
        }
        Paint::Blend(mode) => {
            let sa = mul(u32::from(src[3]), c);
            let src = [src[0], src[1], src[2], sa as u8];
            return composite_pixel(d.map(|v| v as u8), src, mode, 255);
        }
    };
    out.map(|v| v as u8)
}

/// The coverage of a whole stroke: one byte per pixel of `width` × `height`, holding the tip's
/// coverage along the stroke (0 outside it). The Recolor brush masks with it.
pub fn stroke_coverage(
    width: usize,
    height: usize,
    points: &[StrokePoint],
    brush: &BrushSettings,
) -> Vec<u8> {
    let brush = brush.normalized();
    let dabs: Vec<f32> = plan_dabs(points, &brush)
        .into_iter()
        .flat_map(|d| [d.x, d.y, d.diameter])
        .collect();
    let mut values = vec![0u32; width * height * 2];
    cover_dabs(
        &mut values,
        width,
        height,
        (0, 0),
        &dabs,
        &brush,
        true,
        true,
    )
    .expect("x, y, diameter triples");
    stroke_values_coverage(&values, &brush)
}

/// Renders one stroke into a straight-alpha RGBA8 buffer of `width × height` pixels.
///
/// The stroke's coverage is the tip's falloff at each pixel's distance from the path (a round
/// tip's soft distance, see [`crate::brush_field`]; a square tip's largest coverage along the
/// sweep), and the paint is applied once with that coverage over the pixels before the stroke. A
/// soft stroke therefore keeps the tip's falloff across its width instead of building up to full
/// coverage, and its edge is smooth along the stroke and around bends (TL-BRUSH-01 hardness).
pub fn stroke(
    dst: &mut [u8],
    width: usize,
    height: usize,
    points: &[StrokePoint],
    brush: &BrushSettings,
) -> Result<(), String> {
    if dst.len() != width * height * 4 {
        return Err("brush target must be width × height RGBA8".to_owned());
    }
    let brush = brush.normalized();
    let paint = paint_of(&brush)?;
    if brush.hatch > HATCH_COUNT {
        return Err(format!("unknown hatch pattern {}", brush.hatch));
    }
    let cover = stroke_coverage(width, height, points, &brush);
    for (index, &c) in cover.iter().enumerate() {
        if c == 0 {
            continue;
        }
        let (x, y) = (index % width, index / width);
        let i = index * 4;
        let pixel: [u8; 4] = dst[i..i + 4].try_into().expect("four bytes per pixel");
        let src = source_at(&brush, x, y);
        dst[i..i + 4].copy_from_slice(&paint_pixel(pixel, u32::from(c), src, paint));
    }
    Ok(())
}

/// Checks the buffers of a live stroke: `width` × `height` RGBA8 pixels and two words per pixel.
pub(crate) fn check_live_buffers(
    dst: &[u8],
    original: &[u8],
    values: &[u32],
    width: usize,
    height: usize,
) -> Result<(), String> {
    let len = width * height;
    if dst.len() != len * 4 || original.len() != len * 4 {
        return Err("brush target and original must be width × height RGBA8".to_owned());
    }
    if values.len() != len * 2 {
        return Err("the stroke values must be two words per pixel".to_owned());
    }
    Ok(())
}

/// Parses the flat `x, y, pressure` triples of a JavaScript path.
pub(crate) fn stroke_points(path: &[f32]) -> Result<Vec<StrokePoint>, String> {
    if !path.len().is_multiple_of(3) {
        return Err("path must be x, y, pressure triples".to_owned());
    }
    Ok(path
        .as_chunks::<3>()
        .0
        .iter()
        .map(|c| StrokePoint {
            x: c[0],
            y: c[1],
            pressure: c[2],
        })
        .collect())
}

/// Renders a stroke onto a straight-alpha RGBA8 buffer in place. `path` is flat `x, y, pressure`
/// triples in canvas pixels.
#[wasm_bindgen]
pub fn brush_stroke_rgba8(
    dst: &mut [u8],
    width: u32,
    height: u32,
    path: &[f32],
    brush: &BrushSettings,
) -> Result<(), JsError> {
    let points = stroke_points(path).map_err(|m| JsError::new(&m))?;
    stroke(dst, width as usize, height as usize, &points, brush).map_err(|m| JsError::new(&m))
}

/// Adds `dabs` (flat `x, y, diameter` triples in image pixels) to a live stroke. The buffers are
/// `width` × `height` with their top-left pixel at image pixel (`origin_x`, `origin_y`): `dst` is
/// the working copy, `original` the pixels before the stroke and `values` the stroke's two-word
/// values so far (see [`DabPlanner`] for `starts` and `ends`). Where the coverage rises, the pixel
/// is painted again from its original with the new coverage, as [`stroke`] paints the whole
/// stroke. Hatch patterns are anchored to the image origin (TL-OPT-FILL), so a stroke stamped a
/// few dabs at a time, into buffers at different origins, matches one stamped all at once.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn brush_stamp_dabs_rgba8(
    dst: &mut [u8],
    original: &[u8],
    values: &mut [u32],
    width: u32,
    height: u32,
    origin_x: u32,
    origin_y: u32,
    dabs: &[f32],
    starts: bool,
    ends: bool,
    brush: &BrushSettings,
) -> Result<(), JsError> {
    stamp_dabs(
        dst,
        original,
        values,
        width as usize,
        height as usize,
        (origin_x as usize, origin_y as usize),
        dabs,
        brush,
        starts,
        ends,
    )
    .map_err(|m| JsError::new(&m))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn stamp_dabs(
    dst: &mut [u8],
    original: &[u8],
    values: &mut [u32],
    width: usize,
    height: usize,
    origin: (usize, usize),
    dabs: &[f32],
    brush: &BrushSettings,
    starts: bool,
    ends: bool,
) -> Result<(), String> {
    check_live_buffers(dst, original, values, width, height)?;
    let brush = brush.normalized();
    let paint = paint_of(&brush)?;
    if brush.hatch > HATCH_COUNT {
        return Err(format!("unknown hatch pattern {}", brush.hatch));
    }
    let (ox, oy) = origin;
    stamp_with(
        values,
        width,
        height,
        origin,
        dabs,
        &brush,
        starts,
        ends,
        |x, y, c| {
            let i = (y * width + x) * 4;
            let pixel: [u8; 4] = original[i..i + 4].try_into().expect("four bytes per pixel");
            let src = source_at(&brush, x + ox, y + oy);
            dst[i..i + 4].copy_from_slice(&paint_pixel(pixel, c, src, paint));
        },
    )
}

/// Adds the marks of `dabs` to `values` and calls `repaint(x, y, c)` for each buffer pixel whose
/// coverage changed, with the new 8-bit coverage. Only the box the marks can reach is compared.
#[allow(clippy::too_many_arguments)]
pub(crate) fn stamp_with(
    values: &mut [u32],
    width: usize,
    height: usize,
    origin: (usize, usize),
    dabs: &[f32],
    brush: &BrushSettings,
    starts: bool,
    ends: bool,
    mut repaint: impl FnMut(usize, usize, u32),
) -> Result<(), String> {
    let brush = brush.normalized();
    let marks = marks(dabs, &brush, starts, ends)?;
    let Some((x0, y0, x1, y1)) = buffer_box(&marks, width, height, origin) else {
        return Ok(());
    };
    let before: Vec<u32> = (y0..y1)
        .flat_map(|y| {
            values[(y * width + x0) * 2..(y * width + x1) * 2]
                .iter()
                .copied()
        })
        .collect();
    for &mark in &marks {
        apply_mark(values, width, height, origin, mark, &brush);
    }
    let span = x1 - x0;
    for y in y0..y1 {
        for x in x0..x1 {
            let (old, new) = (
                pair(&before, (y - y0) * span + x - x0),
                pair(values, y * width + x),
            );
            if new == old {
                continue;
            }
            // A new term can lower a pixel's coverage as well as raise it (it moves the weighted
            // average), so any change repaints the pixel from its original.
            let c = coverage_of(new, &brush);
            if c != coverage_of(old, &brush) {
                repaint(x, y, c);
            }
        }
    }
    Ok(())
}

/// The buffer box `[x0, x1) × [y0, y1)` that `marks` can change, or `None` when they miss it.
fn buffer_box(
    marks: &[Mark],
    width: usize,
    height: usize,
    origin: (usize, usize),
) -> Option<(usize, usize, usize, usize)> {
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for &mark in marks {
        let (a, b, c, d) = mark_bounds(mark);
        (x0, y0, x1, y1) = (x0.min(a), y0.min(b), x1.max(c), y1.max(d));
    }
    let clip = |v: f32, offset: usize, size: usize| {
        (f64::from(v) - offset as f64).clamp(0.0, size as f64) as usize
    };
    let (x0, x1) = (clip(x0, origin.0, width), clip(x1, origin.0, width));
    let (y0, y1) = (clip(y0, origin.1, height), clip(y1, origin.1, height));
    (x0 < x1 && y0 < y1).then_some((x0, y0, x1, y1))
}

/// Adds the marks of `dabs` (flat `x, y, diameter` triples in image pixels) to a stroke's
/// per-pixel values, as [`stroke_coverage`] does for a whole stroke. The buffer is `width` ×
/// `height` with its top-left pixel at image pixel `origin`, so a stroke added a few dabs at a
/// time matches the whole stroke. [`stroke_values_coverage`] turns the values into coverage.
#[allow(clippy::too_many_arguments)]
pub(crate) fn cover_dabs(
    values: &mut [u32],
    width: usize,
    height: usize,
    origin: (usize, usize),
    dabs: &[f32],
    brush: &BrushSettings,
    starts: bool,
    ends: bool,
) -> Result<(), String> {
    if values.len() != width * height * 2 {
        return Err("the stroke values must be two words per pixel".to_owned());
    }
    let brush = brush.normalized();
    for mark in marks(dabs, &brush, starts, ends)? {
        apply_mark(values, width, height, origin, mark, &brush);
    }
    Ok(())
}

/// Adds `dabs` (flat `x, y, diameter` triples in image pixels) to a stroke's per-pixel values
/// whose top-left pixel is image pixel (`origin_x`, `origin_y`). A live Recolor stroke keeps its
/// values with it (see [`DabPlanner`] for `starts` and `ends`).
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn brush_cover_dabs(
    values: &mut [u32],
    width: u32,
    height: u32,
    origin_x: u32,
    origin_y: u32,
    dabs: &[f32],
    starts: bool,
    ends: bool,
    brush: &BrushSettings,
) -> Result<(), JsError> {
    cover_dabs(
        values,
        width as usize,
        height as usize,
        (origin_x as usize, origin_y as usize),
        dabs,
        brush,
        starts,
        ends,
    )
    .map_err(|m| JsError::new(&m))
}

/// The 8-bit coverage of a stroke's per-pixel values, two words per pixel.
pub(crate) fn stroke_values_coverage(values: &[u32], brush: &BrushSettings) -> Vec<u8> {
    let brush = brush.normalized();
    values
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&v| coverage_of(v, &brush) as u8)
        .collect()
}

/// The 8-bit coverage of a stroke's per-pixel values, two words per pixel (see
/// [`brush_cover_dabs`]).
#[wasm_bindgen]
pub fn brush_values_coverage(values: &[u32], brush: &BrushSettings) -> Vec<u8> {
    stroke_values_coverage(values, brush)
}

/// The dabs of a stroke as flat `x, y, diameter` triples, in stamping order. The WebGPU brush
/// stamps exactly this list.
#[wasm_bindgen]
pub fn brush_dabs(path: &[f32], brush: &BrushSettings) -> Result<Vec<f32>, JsError> {
    let points = stroke_points(path).map_err(|m| JsError::new(&m))?;
    Ok(plan_dabs(&points, brush)
        .into_iter()
        .flat_map(|d| [d.x, d.y, d.diameter])
        .collect())
}

/// Whether the brush sweeps its tip from each dab to the next ([`joins_dabs`]): the GPU twins then
/// cover each pair of consecutive dabs as one segment.
#[wasm_bindgen]
pub fn brush_joins_dabs(brush: &BrushSettings) -> bool {
    joins_dabs(brush)
}

/// Plans the dabs of a stroke whose samples arrive a few at a time, so that a live stroke stamps
/// only its new dabs. Over the whole stroke it yields the dabs of [`plan_dabs`], in order. With
/// smoothing, the spline segment that ends at the newest sample still depends on the samples to
/// come, and a joined stroke's last segment may still grow, so their dabs are held back:
/// [`DabPlanner::tail`] plans them without consuming them, for a preview, and
/// [`DabPlanner::finish`] places them for good.
///
/// When the brush joins its dabs, every non-empty batch after the first starts with the last dab
/// of the batch before, so that each batch covers its own segments: covering the batches one by one
/// gives the coverage of the whole list. [`DabPlanner::starts`] tells whether a batch begins at the
/// stroke's first dab, whose end it covers; batches from `push` don't end the stroke, while those
/// from `tail` and `finish` do. `finish` always returns the last dab placed, so the stroke's end is
/// covered even when nothing new remains.
#[wasm_bindgen]
#[derive(Clone, Debug)]
pub struct DabPlanner {
    brush: BrushSettings,
    /// The samples so far, with consecutive duplicate positions dropped.
    points: Vec<StrokePoint>,
    /// Without smoothing, the samples already placed on the path. With smoothing, the spline
    /// segments already placed.
    placed: usize,
    placer: Placer,
    /// The dabs placed for good so far.
    emitted: usize,
    /// Whether the last batch from `push` or `finish` begins at the stroke's first dab.
    starts: bool,
}

#[wasm_bindgen]
impl DabPlanner {
    #[wasm_bindgen(constructor)]
    pub fn new(brush: &BrushSettings) -> DabPlanner {
        let brush = brush.normalized();
        DabPlanner {
            brush,
            points: Vec::new(),
            placed: 0,
            placer: Placer::new(brush),
            emitted: 0,
            starts: false,
        }
    }

    /// Whether the last batch from `push` or `finish` begins at the stroke's first dab.
    pub fn starts(&self) -> bool {
        self.starts
    }

    /// Whether the batch from `tail` begins at the stroke's first dab.
    pub fn tail_starts(&self) -> bool {
        self.emitted <= 1
    }

    /// Adds samples (flat `x, y, pressure` triples) and returns the dabs that became final, as
    /// flat `x, y, diameter` triples.
    pub fn push(&mut self, path: &[f32]) -> Result<Vec<f32>, JsError> {
        let samples = stroke_points(path).map_err(|m| JsError::new(&m))?;
        for point in samples {
            if self
                .points
                .last()
                .is_none_or(|last| last.x != point.x || last.y != point.y)
            {
                self.points.push(point);
            }
        }
        let joined_to = self.placer.anchor;
        let mut out = Vec::new();
        self.advance(&mut out);
        Ok(self.joined(joined_to, out, false))
    }

    /// The dabs that `finish` would place now, without placing them.
    pub fn tail(&self) -> Vec<f32> {
        self.clone().finish()
    }

    /// Ends the stroke and returns its remaining dabs.
    pub fn finish(&mut self) -> Vec<f32> {
        let joined_to = self.placer.anchor;
        let mut out = Vec::new();
        let n = self.points.len();
        if !self.brush.smooth || n < 2 {
            if self.brush.smooth && n == 1 && self.placed == 0 {
                self.place(self.points[0], &mut out);
                self.placed = 1;
            }
            self.advance(&mut out);
        } else {
            while self.placed + 1 < n {
                self.place_segment(self.placed, &mut out);
                self.placed += 1;
            }
            if self.placed + 1 == n {
                self.place(self.points[n - 1], &mut out);
                self.placed = n;
            }
        }
        self.placer.finish(&mut out);
        self.joined(joined_to, out, true)
    }
}

impl DabPlanner {
    /// A batch of new dabs, led by the last dab placed before them when the brush joins its dabs
    /// (always for the final batch, so that it can cover the stroke's end).
    fn joined(&mut self, before: Option<Dab>, mut out: Vec<f32>, last: bool) -> Vec<f32> {
        let earlier = self.emitted;
        self.emitted += out.len() / 3;
        self.starts = earlier <= 1;
        match before {
            Some(d) if self.placer.joined && (last || !out.is_empty()) => {
                out.splice(0..0, [d.x, d.y, d.diameter]);
                out
            }
            _ => out,
        }
    }

    /// Places every path point that later samples cannot change.
    fn advance(&mut self, out: &mut Vec<f32>) {
        let n = self.points.len();
        if !self.brush.smooth {
            while self.placed < n {
                self.place(self.points[self.placed], out);
                self.placed += 1;
            }
            return;
        }
        // Segment k needs sample k + 2, which only a later sample past the phantom provides.
        while self.placed + 3 <= n {
            self.place_segment(self.placed, out);
            self.placed += 1;
        }
    }

    fn place_segment(&mut self, k: usize, out: &mut Vec<f32>) {
        let mut path = Vec::new();
        spline_segment(&self.points, k, |p| path.push(p));
        for p in path {
            self.place(p, out);
        }
    }

    /// Extends the path to `p` and places the dabs on the new window, as `plan_dabs` does.
    fn place(&mut self, p: StrokePoint, out: &mut Vec<f32>) {
        self.placer.place(p, out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(x: f32, y: f32, pressure: f32) -> StrokePoint {
        StrokePoint { x, y, pressure }
    }

    fn hard_brush(size: f32) -> BrushSettings {
        BrushSettings {
            size,
            hardness: 1.0,
            smooth: false,
            antialias: false,
            ..BrushSettings::default()
        }
    }

    fn canvas(width: usize, height: usize) -> Vec<u8> {
        vec![0; width * height * 4]
    }

    /// FNV-1a over the bytes, for the golden checksum.
    fn fnv1a(bytes: &[u8]) -> u64 {
        bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, &b| {
            (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
        })
    }

    #[test]
    fn stamping_planned_dabs_in_chunks_at_other_origins_matches_the_whole_stroke() {
        let brush = BrushSettings {
            size: 7.0,
            hardness: 0.6,
            smooth: true,
            antialias: true,
            hatch: 3,
            r: 200,
            g: 10,
            b: 40,
            a: 255,
            back_a: 128,
            ..BrushSettings::default()
        };
        let (w, h) = (80, 80);
        let path: Vec<f32> = (0..40)
            .flat_map(|i| {
                let t = i as f32 * 0.3;
                [
                    40.0 + t.cos() * (5.0 + i as f32 * 0.5),
                    40.0 + t.sin() * (5.0 + i as f32 * 0.4),
                    1.0,
                ]
            })
            .collect();
        let mut whole = canvas(w, h);
        stroke(&mut whole, w, h, &stroke_points(&path).unwrap(), &brush).unwrap();

        // The same stroke planned three samples at a time, stamped into a buffer whose top-left
        // is image pixel (8, 6), then copied back into place.
        let mut planner = DabPlanner::new(&brush);
        let (ox, oy, bw, bh) = (8, 6, w - 8, h - 6);
        let mut part = canvas(bw, bh);
        let original = part.clone();
        let mut values = vec![0u32; bw * bh * 2];
        for chunk in path.chunks(9) {
            let dabs = planner.push(chunk).unwrap();
            let starts = planner.starts();
            stamp_dabs(
                &mut part,
                &original,
                &mut values,
                bw,
                bh,
                (ox, oy),
                &dabs,
                &brush,
                starts,
                false,
            )
            .unwrap();
        }
        let rest = planner.finish();
        let starts = planner.starts();
        stamp_dabs(
            &mut part,
            &original,
            &mut values,
            bw,
            bh,
            (ox, oy),
            &rest,
            &brush,
            starts,
            true,
        )
        .unwrap();
        let mut chunked = canvas(w, h);
        for y in 0..bh {
            let from = y * bw * 4;
            let to = ((y + oy) * w + ox) * 4;
            chunked[to..to + bw * 4].copy_from_slice(&part[from..from + bw * 4]);
        }
        // The stroke stays inside the buffer, so the strip outside it is empty in both.
        assert_eq!(chunked, whole);
    }

    #[test]
    fn covering_planned_dabs_in_chunks_at_another_origin_matches_the_stroke_coverage() {
        let brush = BrushSettings {
            size: 9.0,
            hardness: 0.3,
            smooth: true,
            ..BrushSettings::default()
        };
        let (w, h) = (90, 70);
        let points = wobbly_path(12);
        let path = flat_path(&points);
        let whole = stroke_coverage(w, h, &points, &brush);

        let mut planner = DabPlanner::new(&brush);
        let (ox, oy) = (5, 3);
        let (bw, bh) = (w - ox, h - oy);
        let mut values = vec![0u32; bw * bh * 2];
        for (index, chunk) in path.chunks(6).enumerate() {
            let dabs = planner.push(chunk).unwrap();
            cover_dabs(
                &mut values,
                bw,
                bh,
                (ox, oy),
                &dabs,
                &brush,
                planner.starts(),
                false,
            )
            .unwrap();
            // The final part plus the tail is the whole stroke of the samples so far.
            let mut preview = values.clone();
            let tail = planner.tail();
            let ts = planner.tail_starts();
            cover_dabs(&mut preview, bw, bh, (ox, oy), &tail, &brush, ts, true).unwrap();
            let seen = &points[..(points.len()).min((index + 1) * 2)];
            let so_far = stroke_coverage(w, h, seen, &brush);
            let preview = stroke_values_coverage(&preview, &brush);
            for y in oy..h {
                for x in ox..w {
                    assert_eq!(
                        preview[(y - oy) * bw + x - ox],
                        so_far[y * w + x],
                        "{index}"
                    );
                }
            }
        }
        let rest = planner.finish();
        cover_dabs(
            &mut values,
            bw,
            bh,
            (ox, oy),
            &rest,
            &brush,
            planner.starts(),
            true,
        )
        .unwrap();
        let part = stroke_values_coverage(&values, &brush);
        // The buffer misses the strip above and left of its origin, so only its pixels compare.
        for y in oy..h {
            for x in ox..w {
                assert_eq!(part[(y - oy) * bw + x - ox], whole[y * w + x], "({x}, {y})");
            }
        }
        assert!(whole.iter().any(|&c| c > 0));
        assert!(cover_dabs(&mut values, bw + 1, bh, (0, 0), &[], &brush, true, true).is_err());
    }

    #[test]
    fn duplicate_positions_collapse_and_smoothing_keeps_the_samples() {
        let input = [
            point(0.0, 0.0, 1.0),
            point(0.0, 0.0, 0.5),
            point(10.0, 0.0, 1.0),
            point(10.0, 5.0, 0.2),
            point(20.0, 5.0, 1.0),
        ];
        let raw = stroke_path(&input, false);
        assert_eq!(raw.len(), 4);
        let smooth = stroke_path(&input, true);
        for sample in &input[2..] {
            assert!(
                smooth
                    .iter()
                    .any(|p| (p.x - sample.x).abs() < 1e-4 && (p.y - sample.y).abs() < 1e-4),
                "spline misses {sample:?}"
            );
        }
        let last = smooth.last().expect("path has samples");
        assert_eq!((last.x, last.y), (20.0, 5.0));
    }

    #[test]
    fn collinear_samples_stay_on_the_line_when_smoothed() {
        let input: Vec<StrokePoint> = (0..6).map(|i| point(i as f32 * 4.0, 2.0, 1.0)).collect();
        for p in stroke_path(&input, true) {
            assert!((p.y - 2.0).abs() < 1e-4, "{p:?}");
        }
    }

    #[test]
    fn dabs_at_a_spacing_of_100_percent_or_more_are_spaced_by_the_diameter_fraction() {
        // Size 10 at spacing 200 % steps every 20 px along a 100 px line: x = 0, 20, …, 100.
        let brush = BrushSettings {
            size: 10.0,
            spacing: 2.0,
            pressure: false,
            smooth: false,
            ..hard_brush(10.0)
        };
        let dabs = plan_dabs(&[point(0.0, 0.0, 1.0), point(100.0, 0.0, 1.0)], &brush);
        assert_eq!(dabs.len(), 6);
        for (i, dab) in dabs.iter().enumerate() {
            assert!((dab.x - i as f32 * 20.0).abs() < 1e-4, "{dab:?}");
            assert_eq!((dab.y, dab.diameter), (0.0, 10.0));
        }
        assert!(!joins_dabs(&brush));
        // The stamps stay apart: the middle of a gap is not painted.
        let mut dst = canvas(120, 20);
        stroke(
            &mut dst,
            120,
            20,
            &[point(5.0, 10.0, 1.0), point(105.0, 10.0, 1.0)],
            &brush,
        )
        .unwrap();
        assert_eq!(dst[(10 * 120 + 15) * 4 + 3], 0);
        assert_eq!(dst[(10 * 120 + 25) * 4 + 3], 255);
    }

    #[test]
    fn a_joined_straight_line_is_one_segment_whatever_the_spacing() {
        for spacing in [0.01, 0.15, 0.5, 0.99] {
            let brush = BrushSettings {
                size: 40.0,
                spacing,
                pressure: false,
                smooth: true,
                ..BrushSettings::default()
            };
            let path: Vec<StrokePoint> = (0..20).map(|i| point(i as f32 * 3.0, 7.0, 1.0)).collect();
            let dabs = plan_dabs(&path, &brush);
            assert_eq!(
                flat_dabs(&dabs),
                vec![0.0, 7.0, 40.0, 57.0, 7.0, 40.0],
                "spacing {spacing}"
            );
        }
    }

    #[test]
    fn joined_segments_are_no_longer_than_twice_the_diameter() {
        let brush = BrushSettings {
            size: 10.0,
            pressure: false,
            smooth: false,
            ..BrushSettings::default()
        };
        let dabs = plan_dabs(&[point(0.0, 0.0, 1.0), point(100.0, 0.0, 1.0)], &brush);
        assert_eq!(dabs.len(), 6);
        assert!(dabs
            .windows(2)
            .all(|w| (w[1].x - w[0].x - 20.0).abs() < 1e-4));
    }

    /// The distance from (`px`, `py`) to the segment between two dabs.
    fn segment_distance(px: f32, py: f32, a: Dab, b: Dab) -> f32 {
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let ll = dx * dx + dy * dy;
        let t = if ll > 0.0 {
            (((px - a.x) * dx + (py - a.y) * dy) / ll).clamp(0.0, 1.0)
        } else {
            0.0
        };
        (px - a.x - t * dx).hypot(py - a.y - t * dy)
    }

    #[test]
    fn joined_segments_follow_a_curve_within_the_tolerance() {
        // A square tip's polyline stays within size / 2000 of the path (0.015 px here), a round
        // tip's within size / 200 (0.15 px), since its field averages the path over a third of
        // the tip's radius.
        for (square, tolerance) in [(true, 0.016), (false, 0.151)] {
            let brush = BrushSettings {
                size: 30.0,
                pressure: false,
                smooth: true,
                square,
                ..BrushSettings::default()
            };
            let samples: Vec<StrokePoint> = (0..=40)
                .map(|i| {
                    let t = i as f32 * 0.05;
                    point(100.0 + 80.0 * t.cos(), 100.0 + 80.0 * t.sin(), 1.0)
                })
                .collect();
            let dabs = plan_dabs(&samples, &brush);
            assert!(dabs.len() > 3 && dabs.len() < 100, "{}", dabs.len());
            for p in stroke_path(&samples, true) {
                let nearest = dabs
                    .windows(2)
                    .map(|w| segment_distance(p.x, p.y, w[0], w[1]))
                    .fold(f32::MAX, f32::min);
                assert!(nearest < tolerance, "{p:?} is {nearest} px away");
            }
        }
    }

    fn flat_dabs(dabs: &[Dab]) -> Vec<f32> {
        dabs.iter().flat_map(|d| [d.x, d.y, d.diameter]).collect()
    }

    fn flat_path(points: &[StrokePoint]) -> Vec<f32> {
        points.iter().flat_map(|p| [p.x, p.y, p.pressure]).collect()
    }

    /// A wobbly path with repeated positions and varying pressure.
    fn wobbly_path(count: usize) -> Vec<StrokePoint> {
        (0..count)
            .map(|i| {
                let t = i as f32;
                let x = (t * 7.3 + (t * 0.7).sin() * 11.0).floor();
                let y = (t * 3.1 + (t * 0.4).cos() * 17.0).floor();
                point(
                    x,
                    if i % 5 == 3 { (t * 3.1).floor() } else { y },
                    0.3 + (i % 7) as f32 * 0.1,
                )
            })
            .flat_map(|p| [p, p])
            .collect()
    }

    #[test]
    fn the_incremental_planner_places_the_same_dabs_as_the_whole_path() {
        let path = wobbly_path(40);
        for (smooth, spacing) in [(false, 0.15), (true, 0.15), (false, 1.5), (true, 1.5)] {
            let brush = BrushSettings {
                size: 24.0,
                spacing,
                smooth,
                ..BrushSettings::default()
            };
            let joined = joins_dabs(&brush);
            // A joined batch after the first starts with the last dab before it.
            let append = |list: &mut Vec<f32>, batch: Vec<f32>| {
                if joined && !list.is_empty() && !batch.is_empty() {
                    assert_eq!(batch[..3], list[list.len() - 3..]);
                    list.extend_from_slice(&batch[3..]);
                } else {
                    list.extend(batch);
                }
            };
            let expected = flat_dabs(&plan_dabs(&path, &brush));
            for batch in [1, 2, 3, 7, path.len()] {
                let mut planner = DabPlanner::new(&brush);
                let mut actual = Vec::new();
                for (index, chunk) in path.chunks(batch).enumerate() {
                    append(
                        &mut actual,
                        planner.push(&flat_path(chunk)).expect("triples"),
                    );
                    // The tail completes the final dabs into the plan of the samples so far.
                    let mut previewed = actual.clone();
                    append(&mut previewed, planner.tail());
                    let seen = path.len().min((index + 1) * batch);
                    assert_eq!(previewed, flat_dabs(&plan_dabs(&path[..seen], &brush)));
                }
                append(&mut actual, planner.finish());
                assert_eq!(actual, expected, "smooth {smooth}, batch {batch}");
                // Finishing again only repeats the last dab, which covers nothing new.
                assert_eq!(planner.finish().len(), if joined { 3 } else { 0 });
            }
        }
    }

    #[test]
    fn the_incremental_planner_stamps_a_click_once() {
        for smooth in [false, true] {
            let brush = BrushSettings {
                smooth,
                ..BrushSettings::default()
            };
            let mut planner = DabPlanner::new(&brush);
            planner.push(&[7.5, 3.0, 1.0]).expect("triples");
            // The final batch holds the click, as the whole stroke from its start to its end.
            assert_eq!(planner.finish(), vec![7.5, 3.0, 2.0]);
            assert!(planner.starts());
        }
    }

    #[test]
    fn a_click_stamps_one_dab() {
        let dabs = plan_dabs(&[point(7.5, 3.0, 1.0)], &BrushSettings::default());
        assert_eq!(
            dabs,
            vec![Dab {
                x: 7.5,
                y: 3.0,
                diameter: 2.0
            }]
        );
        assert!(plan_dabs(&[], &BrushSettings::default()).is_empty());
    }

    #[test]
    fn pressure_scales_the_diameter_linearly_with_a_floor_of_one_pixel() {
        let brush = BrushSettings::default();
        let big = BrushSettings {
            size: 40.0,
            ..brush
        };
        assert_eq!(diameter_at(&big, 1.0), 40.0);
        assert_eq!(diameter_at(&big, 0.5), 20.0);
        // d × max(p, 1/d): 2 px at pressure 0.1 would be 0.2 px, so it floors at 1 px.
        assert_eq!(diameter_at(&brush, 0.1), 1.0);
        // Pressure off ignores the pen entirely.
        let fixed = BrushSettings {
            pressure: false,
            ..big
        };
        assert_eq!(diameter_at(&fixed, 0.1), 40.0);
    }

    #[test]
    fn pressure_shrinks_the_dabs_and_their_spacing_together() {
        let brush = BrushSettings {
            size: 20.0,
            spacing: 1.25,
            smooth: false,
            ..BrushSettings::default()
        };
        let full = plan_dabs(&[point(0.0, 0.0, 1.0), point(100.0, 0.0, 1.0)], &brush);
        let half = plan_dabs(&[point(0.0, 0.0, 0.5), point(100.0, 0.0, 0.5)], &brush);
        assert_eq!(full.len(), 5);
        assert_eq!(half.len(), 9);
        assert!(half.iter().all(|d| d.diameter == 10.0));
    }

    /// The coverage along row 50 from a click at (50.5, 50.5), from the centre outwards.
    fn click_profile(brush: &BrushSettings) -> Vec<u8> {
        let cover = stroke_coverage(101, 101, &[point(50.5, 50.5, 1.0)], brush);
        (50..101).map(|x| cover[50 * 101 + x]).collect()
    }

    #[test]
    fn hardness_squared_is_the_solid_core_with_a_soft_bell_outside_it() {
        let brush = |hardness: f32| BrushSettings {
            size: 60.0,
            hardness,
            ..BrushSettings::default()
        };
        // Hardness 1: solid up to the last pixel, a 1 px ramp centred on the 30 px radius.
        let hard = click_profile(&brush(1.0));
        assert!(hard[..30].iter().all(|&c| c == 255), "{hard:?}");
        assert!((126..=129).contains(&hard[30]) && hard[31] == 0, "{hard:?}");
        // Hardness 0: no flat core, (1 − ρ²)² over the whole reach (30.5 px).
        let soft = click_profile(&brush(0.0));
        assert_eq!(soft[0], 255);
        assert!(soft[3] < 255, "{soft:?}");
        assert!(soft.windows(2).all(|w| w[1] <= w[0]), "{soft:?}");
        for (d, &c) in soft.iter().enumerate().take(31) {
            let rho = d as f32 / 30.5;
            let expected = (1.0 - rho * rho).powi(2) * ((1.0 - rho) * 30.5).min(1.0) * 255.0;
            assert!(
                (f32::from(c) - expected).abs() <= 1.0,
                "{d}: {c} vs {expected}"
            );
        }
        assert!(soft[15] > 140 && soft[15] < 153, "half radius {}", soft[15]);
        assert_eq!(soft[31], 0);
        // Hardness 0.5: solid over a quarter of the reach, then the bell.
        let half = click_profile(&brush(0.5));
        assert!(half[..7].iter().all(|&c| c == 255), "{half:?}");
        assert!(half[9] < 255 && half[25] > 30 && half[25] < 60, "{half:?}");
    }

    #[test]
    fn aliased_brushes_force_full_hardness_and_no_filtering() {
        let brush = BrushSettings {
            size: 32.0,
            hardness: 0.0,
            antialias: false,
            ..BrushSettings::default()
        };
        let cover = stroke_coverage(
            80,
            60,
            &[point(20.0, 30.0, 1.0), point(60.0, 25.0, 1.0)],
            &brush,
        );
        assert!(cover.iter().all(|&c| c == 0 || c == 255));
        assert!(cover.contains(&255));
    }

    /// The largest spread of alpha along any row over columns `x0..x1`.
    fn row_spread(dst: &[u8], w: usize, h: usize, x0: usize, x1: usize) -> u8 {
        (0..h)
            .map(|y| {
                let row = (x0..x1).map(|x| dst[(y * w + x) * 4 + 3]);
                row.clone().max().unwrap() - row.min().unwrap()
            })
            .max()
            .unwrap()
    }

    #[test]
    fn a_straight_soft_stroke_has_no_ripple_along_its_edge_at_any_spacing() {
        for size in [5.0f32, 20.0, 60.0] {
            for spacing in [0.01, 0.15, 0.5, 0.99] {
                let brush = BrushSettings {
                    size,
                    hardness: 0.0,
                    spacing,
                    pressure: false,
                    ..BrushSettings::default()
                };
                let (w, h) = (300, (size as usize) + 20);
                let y = h as f32 / 2.0 + 0.37;
                let path: Vec<StrokePoint> = (0..80)
                    .map(|i| point(10.0 + i as f32 * 3.3, y, 1.0))
                    .collect();
                let mut dst = canvas(w, h);
                stroke(&mut dst, w, h, &path, &brush).unwrap();
                let (x0, x1) = (12 + size as usize, 270 - size as usize);
                let spread = row_spread(&dst, w, h, x0, x1);
                assert!(
                    spread <= 1,
                    "size {size}, spacing {spacing}: spread {spread}"
                );
            }
        }
    }

    #[test]
    fn a_curved_soft_stroke_depends_only_on_the_distance_from_its_path() {
        // An arc of radius 120 sampled every 4 px: pixels on the same side of the arc and at the
        // same distance from it have the same coverage, within the profile's slope over a 0.02 px
        // bin, so no seams show where segments join.
        let brush = BrushSettings {
            size: 40.0,
            hardness: 0.0,
            pressure: false,
            ..BrushSettings::default()
        };
        let (w, c, r) = (300usize, 150.0f32, 120.0f32);
        let steps = (std::f32::consts::PI * r / 4.0) as usize;
        let path: Vec<StrokePoint> = (0..=steps)
            .map(|i| {
                let t = std::f32::consts::PI * i as f32 / steps as f32;
                point(c + r * t.cos(), c + r * t.sin(), 1.0)
            })
            .collect();
        let mut dst = canvas(w, w);
        stroke(&mut dst, w, w, &path, &brush).unwrap();
        let mut low = [255u8; 2200];
        let mut high = [0u8; 2200];
        for y in 150..w {
            for x in 0..w {
                let (dx, dy) = (x as f32 + 0.5 - c, y as f32 + 0.5 - c);
                let angle = dy.atan2(dx);
                if !(0.3..=2.8).contains(&angle) {
                    continue;
                }
                let bin = (((dx * dx + dy * dy).sqrt() - r + 21.0) * 50.0) as usize;
                if bin < low.len() {
                    let a = dst[(y * w + x) * 4 + 3];
                    low[bin] = low[bin].min(a);
                    high[bin] = high[bin].max(a);
                }
            }
        }
        let spread = (0..low.len())
            .filter(|&b| high[b] >= low[b])
            .map(|b| high[b] - low[b])
            .max()
            .unwrap();
        assert!(spread <= 2, "spread {spread}");
    }

    #[test]
    fn a_round_stroke_keeps_the_capsule_profile_along_and_at_the_ends_of_a_straight_line() {
        // Coverage is the tip's falloff at the distance from the segment: the cross-section and
        // both round ends of a straight stroke are those of the tip swept along it.
        for hardness in [0.0f32, 0.5, 0.75, 1.0] {
            let brush = BrushSettings {
                size: 40.0,
                hardness,
                pressure: false,
                smooth: false,
                ..BrushSettings::default()
            }
            .normalized();
            let (w, h) = (200, 80);
            let (a, b) = (point(40.3, 40.6, 1.0), point(160.8, 37.1, 1.0));
            let cover = stroke_coverage(w, h, &[a, b], &brush);
            let dab = |p: StrokePoint| Dab {
                x: p.x,
                y: p.y,
                diameter: 40.0,
            };
            for y in 0..h {
                for x in 0..w {
                    let d = segment_distance(x as f32 + 0.5, y as f32 + 0.5, dab(a), dab(b));
                    let f = tip_falloff(d / 20.5, 20.5, hardness * hardness, true);
                    let expected = (f * 255.0 + 0.5).floor();
                    let got = f32::from(cover[y * w + x]);
                    assert!(
                        (got - expected).abs() <= 1.0,
                        "h {hardness} ({x}, {y}): {got} vs {expected}"
                    );
                }
            }
        }
    }

    /// The largest second difference of `cover` (along rows, columns and both diagonals).
    fn crease(cover: &[u8], w: usize, h: usize) -> i32 {
        let at = |x: usize, y: usize| i32::from(cover[y * w + x]);
        let mut most = 0;
        for y in 1..h - 1 {
            for x in 1..w - 1 {
                let c = 2 * at(x, y);
                for (p, q) in [
                    (at(x - 1, y), at(x + 1, y)),
                    (at(x, y - 1), at(x, y + 1)),
                    (at(x - 1, y - 1), at(x + 1, y + 1)),
                    (at(x + 1, y - 1), at(x - 1, y + 1)),
                ] {
                    most = most.max((p + q - c).abs());
                }
            }
        }
        most
    }

    /// Test strokes for a 60 px brush in a 200 × 160 image: a straight line, an S-curve, a tight
    /// circle, a zig-zag and a hairpin.
    fn bend_shapes() -> Vec<(&'static str, Vec<StrokePoint>)> {
        let line = |a: (f32, f32), b: (f32, f32), step: f32, out: &mut Vec<StrokePoint>| {
            let n = ((b.0 - a.0).hypot(b.1 - a.1) / step).ceil() as usize;
            for i in 0..=n {
                let t = i as f32 / n as f32;
                out.push(point(a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t, 1.0));
            }
            out.dedup();
        };
        let mut straight = Vec::new();
        line((40.0, 80.5), (160.0, 80.5), 4.0, &mut straight);
        let s_curve = (0..=33)
            .map(|i| {
                let x = 34.0 + i as f32 * 4.0;
                let phase = (x - 34.0) / 132.0 * std::f32::consts::TAU;
                point(x, 80.0 + 27.0 * phase.sin(), 1.0)
            })
            .collect();
        let circle = (0..=36)
            .map(|i| {
                let a = i as f32 / 34.0 * std::f32::consts::TAU;
                point(100.0 + 21.0 * a.cos(), 80.0 + 21.0 * a.sin(), 1.0)
            })
            .collect();
        let mut zig = Vec::new();
        let corners = [
            (34.0, 62.0),
            (67.0, 110.0),
            (100.0, 62.0),
            (133.0, 110.0),
            (166.0, 62.0),
        ];
        for c in corners.windows(2) {
            line(c[0], c[1], 9.0, &mut zig);
        }
        let mut hairpin = Vec::new();
        line((40.0, 62.0), (136.0, 62.0), 4.0, &mut hairpin);
        for i in 1..18 {
            let a = -std::f32::consts::FRAC_PI_2 + std::f32::consts::PI * i as f32 / 18.0;
            hairpin.push(point(136.0 + 18.0 * a.cos(), 80.0 + 18.0 * a.sin(), 1.0));
        }
        line((136.0, 98.0), (40.0, 98.0), 4.0, &mut hairpin);
        vec![
            ("straight", straight),
            ("s-curve", s_curve),
            ("circle", circle),
            ("zig-zag", zig),
            ("hairpin", hairpin),
        ]
    }

    #[test]
    fn bends_corners_and_overlaps_leave_no_crease() {
        // A crease (a kink in the coverage where two parts of the path are equally near) shows as
        // a second difference well above a straight stroke's.
        let (w, h) = (200, 160);
        for hardness in [0.0f32, 0.5, 0.75] {
            let brush = BrushSettings {
                size: 60.0,
                hardness,
                pressure: false,
                ..BrushSettings::default()
            };
            let shapes = bend_shapes();
            let base = crease(&stroke_coverage(w, h, &shapes[0].1, &brush), w, h);
            for (name, path) in &shapes[1..] {
                let found = crease(&stroke_coverage(w, h, path, &brush), w, h);
                // The zig-zag's inner corners bend the edge of the hard core sharply at 75 %.
                let allowed = if hardness == 0.75 && *name == "zig-zag" {
                    3
                } else {
                    2
                };
                assert!(
                    found <= base + allowed,
                    "h {hardness} {name}: {found} vs straight {base}"
                );
            }
        }
    }

    #[test]
    fn a_pressure_taper_narrows_steadily() {
        let brush = BrushSettings {
            size: 40.0,
            hardness: 0.5,
            smooth: false,
            ..BrushSettings::default()
        };
        let (w, h) = (220, 60);
        let mut dst = canvas(w, h);
        let path = [point(10.0, 30.0, 1.0), point(200.0, 30.0, 0.1)];
        stroke(&mut dst, w, h, &path, &brush).unwrap();
        let width = |x: usize| (0..h).filter(|&y| dst[(y * w + x) * 4 + 3] > 0).count();
        let row = |x: usize| dst[(36 * w + x) * 4 + 3];
        for x in 31..195 {
            assert!(width(x + 1) <= width(x), "width at {x}");
            assert!(row(x + 1) <= row(x), "coverage at {x}");
        }
        assert!(width(30) > 30 && width(195) < 10);
    }

    #[test]
    fn a_square_tip_sweeps_a_crisp_box() {
        let brush = BrushSettings {
            square: true,
            ..hard_brush(10.0)
        };
        let path = [point(20.5, 20.5, 1.0), point(60.5, 20.5, 1.0)];
        let cover = stroke_coverage(80, 40, &path, &brush);
        for y in 0..40 {
            for x in 0..80 {
                let inside = (16..=64).contains(&x) && (16..=24).contains(&y);
                assert_eq!(
                    cover[y * 80 + x],
                    if inside { 255 } else { 0 },
                    "({x}, {y})"
                );
            }
        }
        // Diagonally, the swept square reaches its corners but not past the segment's sides.
        let path = [point(20.5, 20.5, 1.0), point(40.5, 40.5, 1.0)];
        let cover = stroke_coverage(80, 80, &path, &brush);
        assert_eq!(cover[36 * 80 + 44], 255);
        assert_eq!(cover[24 * 80 + 31], 255);
        assert_eq!(cover[22 * 80 + 35], 0);
        // An antialiased hard square keeps its corners square.
        let soft_edged = BrushSettings {
            square: true,
            hardness: 1.0,
            antialias: true,
            ..hard_brush(10.0)
        };
        let cover = stroke_coverage(80, 40, &[point(20.0, 20.0, 1.0)], &soft_edged);
        assert_eq!(cover[15 * 80 + 15], 255);
        assert_eq!(cover[24 * 80 + 24], 255);
    }

    /// The alpha down column `x` of a `w`-wide RGBA8 buffer.
    fn alpha_column(dst: &[u8], w: usize, h: usize, x: usize) -> Vec<u8> {
        (0..h).map(|y| dst[(y * w + x) * 4 + 3]).collect()
    }

    #[test]
    fn a_dragged_soft_stroke_keeps_the_falloff_of_one_dab_across_its_width() {
        let (w, h) = (100, 40);
        for spacing in [0.01, 0.15, 0.5] {
            let brush = BrushSettings {
                size: 30.0,
                hardness: 0.0,
                spacing,
                smooth: false,
                pressure: false,
                ..BrushSettings::default()
            };
            let mut dab = canvas(w, h);
            stroke(&mut dab, w, h, &[point(50.5, 20.0, 1.0)], &brush).unwrap();
            let mut line = canvas(w, h);
            let path = [point(10.0, 20.0, 1.0), point(90.0, 20.0, 1.0)];
            stroke(&mut line, w, h, &path, &brush).unwrap();
            let single = alpha_column(&dab, w, h, 50);
            let across = alpha_column(&line, w, h, 50);
            // The single dab's radial profile: a wide ramp from the centre to the rim.
            let ramp = single.iter().filter(|&&a| a > 0 && a < 255).count() / 2;
            assert!(ramp >= 10, "single dab ramp {single:?}");
            // The swept tip never exceeds the coverage of the nearest tip, so the stroke's
            // profile across its width is the dab's profile, not a saturated edge.
            assert_eq!(across, single, "spacing {spacing}");
        }
    }

    #[test]
    fn a_stroke_never_paints_more_than_its_colour_alpha() {
        let brush = BrushSettings {
            size: 20.0,
            hardness: 1.0,
            spacing: 0.05,
            smooth: false,
            a: 100,
            ..BrushSettings::default()
        };
        let mut dst = canvas(60, 30);
        stroke(
            &mut dst,
            60,
            30,
            &[point(10.0, 15.0, 1.0), point(50.0, 15.0, 1.0)],
            &brush,
        )
        .unwrap();
        let max = dst.as_chunks::<4>().0.iter().map(|p| p[3]).max().unwrap();
        assert_eq!(max, 100);
    }

    #[test]
    fn an_aliased_disc_covers_the_pixels_inside_its_radius() {
        let mut dst = canvas(12, 12);
        let brush = BrushSettings {
            r: 10,
            g: 20,
            b: 30,
            a: 255,
            ..hard_brush(6.0)
        };
        stroke(&mut dst, 12, 12, &[point(6.0, 6.0, 1.0)], &brush).expect("stroke");
        let alpha = |x: usize, y: usize| dst[(y * 12 + x) * 4 + 3];
        assert_eq!(alpha(6, 6), 255);
        assert_eq!(alpha(0, 0), 0);
        // Pixel 3's center is 2.5 px from the dab center, inside the 3 px radius; pixel 2's is 3.5 px.
        assert_eq!(alpha(3, 6), 255);
        assert_eq!(alpha(2, 6), 0);
    }

    #[test]
    fn overwrite_replaces_destination_colour_and_alpha() {
        let mut dst = [200, 100, 50, 128].repeat(16);
        let brush = BrushSettings {
            r: 1,
            g: 2,
            b: 3,
            a: 255,
            blend: OVERWRITE,
            ..hard_brush(2.0)
        };
        stroke(&mut dst, 4, 4, &[point(2.0, 2.0, 1.0)], &brush).expect("stroke");
        assert_eq!(&dst[(2 * 4 + 2) * 4..][..4], &[1, 2, 3, 255]);
        assert_eq!(
            &dst[..4],
            &[200, 100, 50, 128],
            "outside the tip is untouched"
        );
    }

    #[test]
    fn erase_scales_alpha_and_keeps_colour() {
        let mut dst = [200, 100, 50, 255].repeat(16);
        let brush = BrushSettings {
            erase: true,
            ..hard_brush(2.0)
        };
        stroke(&mut dst, 4, 4, &[point(2.0, 2.0, 1.0)], &brush).expect("stroke");
        assert_eq!(&dst[(2 * 4 + 2) * 4..][..4], &[200, 100, 50, 0]);
        assert_eq!(&dst[..4], &[200, 100, 50, 255]);
    }

    #[test]
    fn white_multiply_leaves_the_destination_alone() {
        let mut dst = [40, 90, 200, 255].repeat(16);
        let brush = BrushSettings {
            r: 255,
            g: 255,
            b: 255,
            blend: BlendMode::Multiply as u8,
            ..hard_brush(8.0)
        };
        stroke(&mut dst, 4, 4, &[point(2.0, 2.0, 1.0)], &brush).expect("stroke");
        assert_eq!(dst, [40, 90, 200, 255].repeat(16));
    }

    #[test]
    fn rejects_bad_targets_and_blend_values() {
        let brush = BrushSettings::default();
        assert!(stroke(&mut [0; 8], 2, 2, &[], &brush).is_err());
        let unknown = BrushSettings { blend: 15, ..brush };
        assert!(stroke(&mut canvas(2, 2), 2, 2, &[point(1.0, 1.0, 1.0)], &unknown).is_err());
        assert!(stroke_points(&[1.0, 2.0]).is_err());
    }

    /// Golden: a smoothed, pressure-varying stroke with a soft antialiased tip and a
    /// semi-transparent colour. The checksum pins the Rust reference output (WEB-GPU-03).
    #[test]
    fn golden_checksum_of_a_smoothed_pressure_stroke() {
        let path: Vec<StrokePoint> = [
            (4.0, 6.0, 0.2),
            (30.0, 10.0, 0.6),
            (52.0, 40.0, 1.0),
            (70.0, 44.0, 0.4),
            (90.0, 20.0, 0.8),
            (110.0, 30.0, 0.5),
        ]
        .map(|(x, y, p)| point(x, y, p))
        .to_vec();
        let brush = BrushSettings {
            size: 14.0,
            hardness: 0.75,
            spacing: 0.15,
            a: 200,
            r: 180,
            g: 40,
            b: 90,
            ..BrushSettings::default()
        };
        let mut dst = canvas(120, 60);
        stroke(&mut dst, 120, 60, &path, &brush).expect("stroke");
        let (pixels, _) = dst.as_chunks::<4>();
        assert!(
            pixels.iter().any(|px| px[3] > 0),
            "the stroke painted nothing"
        );
        assert_eq!(fnv1a(&dst), GOLDEN_STROKE);
    }

    const GOLDEN_STROKE: u64 = 12_606_829_933_992_041_227;

    /// The tile bit that TL-OPT-FILL names for each pattern, written as a formula over (x, y).
    fn expected_hatch(style: u8, x: usize, y: usize) -> bool {
        match style {
            1 => y.is_multiple_of(4),
            2 => x.is_multiple_of(4),
            3 => (x + y).is_multiple_of(4),
            4 => (x + 4 * 8 - y).is_multiple_of(4),
            5 => y.is_multiple_of(4) || x.is_multiple_of(4),
            6 => (x + y).is_multiple_of(4) || (x + 4 * 8 - y).is_multiple_of(4),
            7 => (x + y).is_multiple_of(2),
            8 => x.is_multiple_of(4) && y.is_multiple_of(4),
            _ => unreachable!("pattern {style}"),
        }
    }

    #[test]
    fn hatch_tiles_match_their_named_patterns() {
        for style in 1..=HATCH_COUNT {
            for y in 0..8 {
                for x in 0..8 {
                    assert_eq!(
                        hatch_bit(style, x, y),
                        expected_hatch(style, x, y),
                        "pattern {style} at ({x}, {y})"
                    );
                }
            }
        }
    }

    #[test]
    fn a_hatched_stroke_paints_foreground_and_background_by_the_pattern() {
        let brush = BrushSettings {
            r: 200,
            g: 0,
            b: 0,
            a: 255,
            back_r: 0,
            back_g: 0,
            back_b: 200,
            hatch: 3,
            ..hard_brush(8.0)
        };
        let mut dst = canvas(12, 12);
        stroke(&mut dst, 12, 12, &[point(4.0, 4.0, 1.0)], &brush).expect("stroke");
        let at = |x: usize, y: usize| &dst[(y * 12 + x) * 4..][..4];
        // Forward Diagonal sets (x + y) % 4 == 0: (4, 4) is set and (5, 4) is not.
        assert_eq!(at(4, 4), &[200, 0, 0, 255]);
        assert_eq!(at(5, 4), &[0, 0, 200, 255]);
        assert_eq!(at(3, 5), &[200, 0, 0, 255]);
    }

    #[test]
    fn a_solid_brush_ignores_the_background_color() {
        let mut solid = canvas(8, 8);
        let mut other_back = canvas(8, 8);
        let brush = BrushSettings {
            r: 9,
            g: 8,
            b: 7,
            ..hard_brush(6.0)
        };
        stroke(&mut solid, 8, 8, &[point(4.0, 4.0, 1.0)], &brush).expect("stroke");
        let with_back = BrushSettings {
            back_r: 1,
            back_g: 2,
            back_b: 3,
            back_a: 4,
            ..brush
        };
        stroke(&mut other_back, 8, 8, &[point(4.0, 4.0, 1.0)], &with_back).expect("stroke");
        assert_eq!(solid, other_back);
    }

    #[test]
    fn stroke_coverage_is_full_under_the_tip_and_zero_outside_it() {
        let cover = stroke_coverage(12, 12, &[point(6.0, 6.0, 1.0)], &hard_brush(6.0));
        assert_eq!(cover.len(), 144);
        assert_eq!(cover[6 * 12 + 6], 255);
        assert_eq!(cover[0], 0);
        assert_eq!(
            cover[6 * 12 + 9],
            0,
            "three pixels away is outside a 6 px tip"
        );
    }

    #[test]
    fn rejects_an_unknown_hatch_pattern() {
        let brush = BrushSettings {
            hatch: 9,
            ..hard_brush(4.0)
        };
        assert!(stroke(&mut canvas(4, 4), 4, 4, &[point(2.0, 2.0, 1.0)], &brush).is_err());
    }
}
