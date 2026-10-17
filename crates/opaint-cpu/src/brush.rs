//! Brush engine (TL-BRUSH-01, TL-OPT-BRUSH, TL-OPT-AA, TL-OPT-BLEND, TL-OPT-SMOOTH).
//!
//! This is the reference for the WebGPU brush twin. The dab list and the tip sprite are computed
//! here and shared with the GPU path, so both place and shape every dab identically. Pixels are
//! straight-alpha RGBA8, as everywhere else in the crate.

use crate::blend::{composite_pixel, mul, BlendMode};
use wasm_bindgen::prelude::*;

/// Blend value that replaces the destination, alpha included (TL-OPT-BLEND "Overwrite"). Values
/// 0-13 are the layer blend modes of [`BlendMode`].
pub const OVERWRITE: u8 = 14;
/// Smallest tip sprite resolution in pixels (TL-BRUSH-01).
const MIN_TIP_RESOLUTION: usize = 32;
/// Hard core diameter at hardness 0 as a fraction of the tip diameter: 1.18875 / 2 (TL-BRUSH-01).
const CORE_AT_ZERO_HARDNESS: f32 = 0.594_375;
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
    /// Hardness 0..=1 (TL-OPT-BRUSH "Hardness"). Ignored, and treated as 1, when `antialias` is off.
    pub hardness: f32,
    /// Spacing as a fraction of the tip diameter, 0.01..=5.
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

/// Places the dabs along the (smoothed) path. The first dab sits on the first sample. Each next
/// dab is `spacing × diameter` further along the path, measured as Euclidean arc length, with the
/// diameter taken at the pressure of the dab's own position (TL-BRUSH-01).
pub fn plan_dabs(points: &[StrokePoint], brush: &BrushSettings) -> Vec<Dab> {
    let brush = brush.normalized();
    let path = stroke_path(points, brush.smooth);
    let Some(first) = path.first().copied() else {
        return Vec::new();
    };
    let mut dabs = vec![Dab {
        x: first.x,
        y: first.y,
        diameter: diameter_at(&brush, first.pressure),
    }];
    let mut next = f64::from(brush.spacing * dabs[0].diameter);
    let mut start = 0.0_f64;
    for segment in path.windows(2) {
        let (a, b) = (segment[0], segment[1]);
        let len = distance(point3(a), point3(b));
        while next <= start + len {
            let t = ((next - start) / len) as f32;
            let x = a.x + (b.x - a.x) * t;
            let y = a.y + (b.y - a.y) * t;
            let diameter = diameter_at(&brush, a.pressure + (b.pressure - a.pressure) * t);
            dabs.push(Dab { x, y, diameter });
            next += f64::from(brush.spacing * diameter);
        }
        start += len;
    }
    dabs
}

/// Resolution of the square tip sprite: the tip size rounded up, and at least 32 px (TL-BRUSH-01).
pub fn tip_resolution(size: f32) -> usize {
    (size.ceil() as usize).max(MIN_TIP_RESOLUTION)
}

/// Coverage of the tip at a radius `rho` from its center, with `rho` in units of the tip radius.
/// Full inside the hard core, a linear ramp to zero at the full radius.
fn falloff(rho: f32, core: f32) -> f32 {
    if rho >= 1.0 {
        0.0
    } else if rho <= core {
        1.0
    } else {
        (1.0 - rho) / (1.0 - core)
    }
}

/// The tip coverage as an `n × n` row-major sprite of f32 values in 0..=1. The sprite covers the
/// full nominal diameter, so a smaller dab samples it at the same relative positions.
pub fn tip_sprite(brush: &BrushSettings) -> Vec<f32> {
    let brush = brush.normalized();
    let n = tip_resolution(brush.size);
    let hardness = if brush.antialias { brush.hardness } else { 1.0 };
    let core = CORE_AT_ZERO_HARDNESS + (1.0 - CORE_AT_ZERO_HARDNESS) * hardness;
    let scale = 2.0 / n as f32;
    let mut sprite = Vec::with_capacity(n * n);
    for j in 0..n {
        let oy = (j as f32 + 0.5) * scale - 1.0;
        for i in 0..n {
            let ox = (i as f32 + 0.5) * scale - 1.0;
            let rho = if brush.square {
                ox.abs().max(oy.abs())
            } else {
                (ox * ox + oy * oy).sqrt()
            };
            sprite.push(falloff(rho, core));
        }
    }
    sprite
}

/// Samples the sprite at `(lx, ly)` in tip radii, both in -1..1. Antialiased brushes interpolate
/// bilinearly; aliased brushes take the nearest sprite pixel.
fn tip_coverage(sprite: &[f32], n: usize, lx: f32, ly: f32, antialias: bool) -> f32 {
    let u = (lx + 1.0) * 0.5 * n as f32;
    let v = (ly + 1.0) * 0.5 * n as f32;
    let at = |x: f32, y: f32| {
        let max = (n - 1) as f32;
        let (x, y) = (x.clamp(0.0, max) as usize, y.clamp(0.0, max) as usize);
        sprite[y * n + x]
    };
    if antialias {
        let (fx, fy) = (u - 0.5, v - 0.5);
        let (x0, y0) = (fx.floor(), fy.floor());
        let (tx, ty) = (fx - x0, fy - y0);
        let top = at(x0, y0) * (1.0 - tx) + at(x0 + 1.0, y0) * tx;
        let bottom = at(x0, y0 + 1.0) * (1.0 - tx) + at(x0 + 1.0, y0 + 1.0) * tx;
        top * (1.0 - ty) + bottom * ty
    } else {
        at(u.floor(), v.floor())
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

/// Calls `visit(x, y, c)` for each pixel of `width` × `height` that the dab covers, where `c` is
/// the 8-bit tip coverage (1 to 255). Pixels with no coverage are skipped.
pub(crate) fn dab_coverage(
    dab: Dab,
    sprite: &[f32],
    brush: &BrushSettings,
    width: usize,
    height: usize,
    mut visit: impl FnMut(usize, usize, u32),
) {
    let n = (sprite.len() as f64).sqrt() as usize;
    let radius = dab.diameter * 0.5;
    let x0 = (dab.x - radius).floor().max(0.0) as usize;
    let x1 = ((dab.x + radius).ceil().max(0.0) as usize).min(width);
    let y0 = (dab.y - radius).floor().max(0.0) as usize;
    let y1 = ((dab.y + radius).ceil().max(0.0) as usize).min(height);
    for y in y0..y1 {
        for x in x0..x1 {
            let lx = (x as f32 + 0.5 - dab.x) / radius;
            let ly = (y as f32 + 0.5 - dab.y) / radius;
            if lx.abs() >= 1.0 || ly.abs() >= 1.0 {
                continue;
            }
            let coverage = tip_coverage(sprite, n, lx, ly, brush.antialias);
            let c = (coverage * 255.0 + 0.5).floor() as u32;
            if c != 0 {
                visit(x, y, c);
            }
        }
    }
}

/// The coverage of a whole stroke: one byte per pixel of `width` × `height`, holding the largest
/// tip coverage of any dab over it (0 outside the stroke). The Recolor brush masks with it.
pub fn stroke_coverage(
    width: usize,
    height: usize,
    points: &[StrokePoint],
    brush: &BrushSettings,
) -> Vec<u8> {
    let brush = brush.normalized();
    let sprite = tip_sprite(&brush);
    let mut cover = vec![0u8; width * height];
    for dab in plan_dabs(points, &brush) {
        dab_coverage(dab, &sprite, &brush, width, height, |x, y, c| {
            let cell = &mut cover[y * width + x];
            *cell = (*cell).max(c.min(255) as u8);
        });
    }
    cover
}

/// Renders one stroke into a straight-alpha RGBA8 buffer of `width × height` pixels.
///
/// The stroke's coverage is the largest tip coverage of any dab over each pixel, and the paint is
/// applied once with that coverage over the pixels before the stroke. Overlapping soft dabs
/// therefore keep the tip's falloff across the stroke's width instead of building up to full
/// coverage, and the result does not depend on the spacing (TL-BRUSH-01 hardness).
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

/// Checks the buffers of a live stroke: `width` × `height` RGBA8 pixels and coverage bytes.
pub(crate) fn check_live_buffers(
    dst: &[u8],
    original: &[u8],
    cover: &[u8],
    width: usize,
    height: usize,
) -> Result<(), String> {
    let len = width * height;
    if dst.len() != len * 4 || original.len() != len * 4 {
        return Err("brush target and original must be width × height RGBA8".to_owned());
    }
    if cover.len() != len {
        return Err("coverage must be width × height bytes".to_owned());
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
/// the working copy, `original` the pixels before the stroke and `cover` the stroke's coverage so
/// far, one byte per pixel. Where a dab raises the coverage, the pixel is painted again from its
/// original with the new coverage, as [`stroke`] paints the whole stroke. Hatch patterns are
/// anchored to the image origin (TL-OPT-FILL), so a stroke stamped a few dabs at a time, into
/// buffers at different origins, matches one stamped all at once. With a live stroke this stamps
/// only the dabs new since the last frame (see [`DabPlanner`]).
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn brush_stamp_dabs_rgba8(
    dst: &mut [u8],
    original: &[u8],
    cover: &mut [u8],
    width: u32,
    height: u32,
    origin_x: u32,
    origin_y: u32,
    dabs: &[f32],
    brush: &BrushSettings,
) -> Result<(), JsError> {
    stamp_dabs(
        dst,
        original,
        cover,
        width as usize,
        height as usize,
        (origin_x as usize, origin_y as usize),
        dabs,
        brush,
    )
    .map_err(|m| JsError::new(&m))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn stamp_dabs(
    dst: &mut [u8],
    original: &[u8],
    cover: &mut [u8],
    width: usize,
    height: usize,
    origin: (usize, usize),
    dabs: &[f32],
    brush: &BrushSettings,
) -> Result<(), String> {
    check_live_buffers(dst, original, cover, width, height)?;
    let brush = brush.normalized();
    let paint = paint_of(&brush)?;
    if brush.hatch > HATCH_COUNT {
        return Err(format!("unknown hatch pattern {}", brush.hatch));
    }
    let (ox, oy) = origin;
    visit_dabs(width, height, origin, dabs, &brush, |x, y, c| {
        let cell = &mut cover[y * width + x];
        if c <= u32::from(*cell) {
            return;
        }
        *cell = c.min(255) as u8;
        let i = (y * width + x) * 4;
        let pixel: [u8; 4] = original[i..i + 4].try_into().expect("four bytes per pixel");
        let src = source_at(&brush, x + ox, y + oy);
        dst[i..i + 4].copy_from_slice(&paint_pixel(pixel, c, src, paint));
    })
}

/// Calls `visit(x, y, c)` for each pixel of a `width` × `height` buffer whose top-left pixel is
/// image pixel `origin` that one of `dabs` (flat `x, y, diameter` triples in image pixels) covers,
/// dab by dab in order. `x` and `y` are buffer pixels.
pub(crate) fn visit_dabs(
    width: usize,
    height: usize,
    origin: (usize, usize),
    dabs: &[f32],
    brush: &BrushSettings,
    mut visit: impl FnMut(usize, usize, u32),
) -> Result<(), String> {
    if !dabs.len().is_multiple_of(3) {
        return Err("dabs must be x, y, diameter triples".to_owned());
    }
    let brush = brush.normalized();
    let sprite = tip_sprite(&brush);
    let (ox, oy) = origin;
    for d in dabs.as_chunks::<3>().0 {
        let dab = Dab {
            x: d[0] - ox as f32,
            y: d[1] - oy as f32,
            diameter: d[2],
        };
        dab_coverage(dab, &sprite, &brush, width, height, &mut visit);
    }
    Ok(())
}

/// Raises each byte of the coverage buffer `cover` to the tip coverage of `dabs` over it, as
/// [`stroke_coverage`] does for a whole stroke. The buffer is `width` × `height` with its top-left
/// pixel at image pixel `origin`, so a stroke covered a few dabs at a time matches its whole
/// coverage.
pub(crate) fn cover_dabs(
    cover: &mut [u8],
    width: usize,
    height: usize,
    origin: (usize, usize),
    dabs: &[f32],
    brush: &BrushSettings,
) -> Result<(), String> {
    if cover.len() != width * height {
        return Err("coverage must be width × height bytes".to_owned());
    }
    visit_dabs(width, height, origin, dabs, brush, |x, y, c| {
        let cell = &mut cover[y * width + x];
        *cell = (*cell).max(c.min(255) as u8);
    })
}

/// Max-combines the tip coverage of `dabs` (flat `x, y, diameter` triples in image pixels) into
/// a one-byte-per-pixel coverage buffer whose top-left pixel is image pixel (`origin_x`,
/// `origin_y`). A live Recolor stroke keeps its coverage with it (see [`DabPlanner`]).
#[wasm_bindgen]
pub fn brush_cover_dabs(
    cover: &mut [u8],
    width: u32,
    height: u32,
    origin_x: u32,
    origin_y: u32,
    dabs: &[f32],
    brush: &BrushSettings,
) -> Result<(), JsError> {
    cover_dabs(
        cover,
        width as usize,
        height as usize,
        (origin_x as usize, origin_y as usize),
        dabs,
        brush,
    )
    .map_err(|m| JsError::new(&m))
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

/// The tip coverage sprite as `n × n` row-major f32 values, with `n` the square root of the length.
#[wasm_bindgen]
pub fn brush_tip_sprite(brush: &BrushSettings) -> Vec<f32> {
    tip_sprite(brush)
}

/// Plans the dabs of a stroke whose samples arrive a few at a time, so that a live stroke stamps
/// only its new dabs (engine v2). Over the whole stroke it yields exactly the dabs of
/// [`plan_dabs`], in order. With smoothing, the spline segment that ends at the newest sample
/// still depends on the samples to come, so its dabs are held back: [`DabPlanner::tail`] plans
/// them without consuming them, for a preview, and [`DabPlanner::finish`] places them for good.
#[wasm_bindgen]
#[derive(Clone, Debug)]
pub struct DabPlanner {
    brush: BrushSettings,
    /// The samples so far, with consecutive duplicate positions dropped.
    points: Vec<StrokePoint>,
    /// Without smoothing, the samples already placed on the path. With smoothing, the spline
    /// segments already placed.
    placed: usize,
    /// The last point placed on the path: where the next path window starts.
    last: Option<StrokePoint>,
    /// Arc length of the next dab, and of `last`, along the path.
    next: f64,
    start: f64,
}

#[wasm_bindgen]
impl DabPlanner {
    #[wasm_bindgen(constructor)]
    pub fn new(brush: &BrushSettings) -> DabPlanner {
        DabPlanner {
            brush: brush.normalized(),
            points: Vec::new(),
            placed: 0,
            last: None,
            next: 0.0,
            start: 0.0,
        }
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
        let mut out = Vec::new();
        self.advance(&mut out);
        Ok(out)
    }

    /// The dabs that `finish` would place now, without placing them.
    pub fn tail(&self) -> Vec<f32> {
        self.clone().finish()
    }

    /// Ends the stroke and returns its remaining dabs.
    pub fn finish(&mut self) -> Vec<f32> {
        let mut out = Vec::new();
        let n = self.points.len();
        if !self.brush.smooth || n < 2 {
            if self.brush.smooth && n == 1 && self.placed == 0 {
                self.place(self.points[0], &mut out);
                self.placed = 1;
            }
            self.advance(&mut out);
            return out;
        }
        while self.placed + 1 < n {
            self.place_segment(self.placed, &mut out);
            self.placed += 1;
        }
        if self.placed + 1 == n {
            self.place(self.points[n - 1], &mut out);
            self.placed = n;
        }
        out
    }
}

impl DabPlanner {
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
        let mut cover = vec![0u8; bw * bh];
        for chunk in path.chunks(9) {
            let dabs = planner.push(chunk).unwrap();
            stamp_dabs(
                &mut part,
                &original,
                &mut cover,
                bw,
                bh,
                (ox, oy),
                &dabs,
                &brush,
            )
            .unwrap();
        }
        let rest = planner.finish();
        stamp_dabs(
            &mut part,
            &original,
            &mut cover,
            bw,
            bh,
            (ox, oy),
            &rest,
            &brush,
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
        let mut part = vec![0u8; bw * bh];
        for chunk in path.chunks(6) {
            let dabs = planner.push(chunk).unwrap();
            cover_dabs(&mut part, bw, bh, (ox, oy), &dabs, &brush).unwrap();
        }
        cover_dabs(&mut part, bw, bh, (ox, oy), &planner.finish(), &brush).unwrap();
        // The buffer misses the strip above and left of its origin, so only its pixels compare.
        for y in oy..h {
            for x in ox..w {
                assert_eq!(part[(y - oy) * bw + x - ox], whole[y * w + x], "({x}, {y})");
            }
        }
        assert!(whole.iter().any(|&c| c > 0));
        assert!(cover_dabs(&mut part, bw + 1, bh, (0, 0), &[], &brush).is_err());
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
    fn dabs_are_spaced_by_the_diameter_fraction() {
        // Size 10 at spacing 50 % steps every 5 px along a 100 px line: 21 dabs at x = 0, 5, …, 100.
        let brush = BrushSettings {
            size: 10.0,
            spacing: 0.5,
            pressure: false,
            smooth: false,
            ..hard_brush(10.0)
        };
        let dabs = plan_dabs(&[point(0.0, 0.0, 1.0), point(100.0, 0.0, 1.0)], &brush);
        assert_eq!(dabs.len(), 21);
        for (i, dab) in dabs.iter().enumerate() {
            assert!((dab.x - i as f32 * 5.0).abs() < 1e-4, "{dab:?}");
            assert_eq!((dab.y, dab.diameter), (0.0, 10.0));
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
        for smooth in [false, true] {
            let brush = BrushSettings {
                size: 24.0,
                spacing: 0.15,
                smooth,
                ..BrushSettings::default()
            };
            let expected = flat_dabs(&plan_dabs(&path, &brush));
            for batch in [1, 2, 3, 7, path.len()] {
                let mut planner = DabPlanner::new(&brush);
                let mut actual = Vec::new();
                for (index, chunk) in path.chunks(batch).enumerate() {
                    actual.extend(planner.push(&flat_path(chunk)).expect("triples"));
                    // The tail completes the final dabs into the plan of the samples so far.
                    let mut previewed = actual.clone();
                    previewed.extend(planner.tail());
                    let seen = path.len().min((index + 1) * batch);
                    assert_eq!(previewed, flat_dabs(&plan_dabs(&path[..seen], &brush)));
                }
                actual.extend(planner.finish());
                assert_eq!(actual, expected, "smooth {smooth}, batch {batch}");
                assert!(planner.finish().is_empty());
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
            let mut dabs = planner.push(&[7.5, 3.0, 1.0]).expect("triples");
            dabs.extend(planner.finish());
            assert_eq!(dabs, vec![7.5, 3.0, 2.0]);
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
            spacing: 0.25,
            smooth: false,
            ..BrushSettings::default()
        };
        let full = plan_dabs(&[point(0.0, 0.0, 1.0), point(100.0, 0.0, 1.0)], &brush);
        let half = plan_dabs(&[point(0.0, 0.0, 0.5), point(100.0, 0.0, 0.5)], &brush);
        assert_eq!(full.len(), 21);
        assert_eq!(half.len(), 41);
        assert!(half.iter().all(|d| d.diameter == 10.0));
    }

    #[test]
    fn hardness_sets_the_core_and_falloff_of_the_sprite() {
        let hard = tip_sprite(&BrushSettings {
            size: 64.0,
            hardness: 1.0,
            ..BrushSettings::default()
        });
        assert!(hard.iter().all(|&v| v == 0.0 || v == 1.0));
        let soft = tip_sprite(&BrushSettings {
            size: 64.0,
            hardness: 0.0,
            ..BrushSettings::default()
        });
        let n = 64;
        // Sprite pixel (i, n/2) has rho between the core edge (0.594) and 1: a linear ramp.
        let at = |i: usize| soft[(n / 2) * n + i];
        let center = at(n / 2);
        let edge_of_core = at(n / 2 + (0.6 * n as f32 / 2.0) as usize);
        assert_eq!(center, 1.0);
        assert!(edge_of_core < 1.0 && edge_of_core > 0.0, "{edge_of_core}");
        assert!(at(n - 1) < at(n / 2 + 16));
        assert!((soft[0]).abs() < 1e-6);
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
            stroke(&mut dab, w, h, &[point(50.0, 20.0, 1.0)], &brush).unwrap();
            let mut line = canvas(w, h);
            let path = [point(10.0, 20.0, 1.0), point(90.0, 20.0, 1.0)];
            stroke(&mut line, w, h, &path, &brush).unwrap();
            let single = alpha_column(&dab, w, h, 50);
            let across = alpha_column(&line, w, h, 50);
            // The single dab's radial profile: a wide ramp from the core to the rim.
            let ramp = single.iter().filter(|&&a| a > 0 && a < 255).count() / 2;
            assert!(ramp >= 5, "single dab ramp {single:?}");
            // Overlapping dabs never exceed the coverage of the nearest dab, so the stroke's
            // profile across its width is the dab's profile, not a saturated edge.
            for y in 0..h {
                let (a, b) = (i32::from(across[y]), i32::from(single[y]));
                let tolerance = if spacing <= 0.01 { 3 } else { 255 };
                assert!(
                    a >= b - tolerance && a <= b + 3,
                    "spacing {spacing} y {y}: {a} vs {b}"
                );
            }
            // Halfway out the ramp, the old accumulated stroke reached nearly full alpha.
            let half = single.iter().position(|&a| a > 0).unwrap() + ramp / 2;
            assert!(across[half] < 200, "spacing {spacing}: edge {across:?}");
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
    fn aliased_brushes_force_full_hardness_and_no_filtering() {
        let aliased = tip_sprite(&BrushSettings {
            size: 32.0,
            hardness: 0.0,
            antialias: false,
            ..BrushSettings::default()
        });
        assert!(aliased.iter().all(|&v| v == 0.0 || v == 1.0));
    }

    #[test]
    fn small_tips_are_rendered_at_32_pixels() {
        assert_eq!(tip_resolution(2.0), 32);
        assert_eq!(tip_resolution(40.0), 40);
        assert_eq!(tip_resolution(40.2), 41);
        assert_eq!(tip_sprite(&BrushSettings::default()).len(), 32 * 32);
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

    const GOLDEN_STROKE: u64 = 18_011_631_598_814_807_980;

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
