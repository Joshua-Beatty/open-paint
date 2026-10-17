//! Gradient fill (TL-GRAD-01, TL-ALG-GRAD, TL-OPT-GRAD). This is the reference for the
//! gradient tool: the seven shape functions, the three repeat rules, the color and transparency
//! modes, the dither and the adaptive supersampling. Pixels are straight-alpha RGBA8. Each pixel is
//! composited with the brush's paint rules (`brush::paint_pixel`), so the blend modes and Overwrite
//! behave the same as in the other tools.

use crate::blend::mul;
use crate::brush::{paint_for, paint_pixel, Paint};
use std::f64::consts::{PI, TAU};
use wasm_bindgen::prelude::*;

/// Pixels whose shape values differ by more than this across their samples are subdivided.
const SUBDIVIDE_SPREAD: f64 = 0.05;
/// The most times a pixel is split into quadrants.
const MAX_DEPTH: u32 = 3;
/// Gradients shorter than this many pixels are supersampled (TL-ALG-GRAD).
const SUPERSAMPLE_LENGTH: f64 = 8.0;

/// The shape function of a gradient (TL-OPT-GRAD, TL-ALG-GRAD). The ids follow the settings choices.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Shape {
    LinearClamped = 0,
    LinearReflected = 1,
    LinearDiamond = 2,
    Radial = 3,
    Conical = 4,
    Spiral = 5,
    SpiralCounterClockwise = 6,
}

impl TryFrom<u8> for Shape {
    type Error = u8;

    fn try_from(value: u8) -> Result<Self, u8> {
        Ok(match value {
            0 => Self::LinearClamped,
            1 => Self::LinearReflected,
            2 => Self::LinearDiamond,
            3 => Self::Radial,
            4 => Self::Conical,
            5 => Self::Spiral,
            6 => Self::SpiralCounterClockwise,
            other => return Err(other),
        })
    }
}

/// The repeat rule applied to the shape value (TL-OPT-GRAD, TL-ALG-GRAD).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Repeat {
    NoRepeat,
    Wrapped,
    Reflected,
}

impl TryFrom<u8> for Repeat {
    type Error = u8;

    fn try_from(value: u8) -> Result<Self, u8> {
        match value {
            0 => Ok(Self::NoRepeat),
            1 => Ok(Self::Wrapped),
            2 => Ok(Self::Reflected),
            other => Err(other),
        }
    }
}

/// The settings of one gradient (TL-OPT-GRAD). The start and end colors are passed beside them as
/// eight bytes, so the struct stays plain numbers for the WASM boundary.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GradientSettings {
    /// The shape, 0-6 (`Shape`).
    pub shape: u8,
    /// The repeat rule, 0-2 (`Repeat`).
    pub repeat: u8,
    /// The start point, in canvas pixels.
    pub start_x: f64,
    pub start_y: f64,
    /// The end point, in canvas pixels. A start equal to the end draws nothing.
    pub end_x: f64,
    pub end_y: f64,
    /// Transparency mode (TL-ALG-GRAD): the gradient sets alpha only. The alpha ramps from the start
    /// color's alpha to the end color's alpha.
    pub alpha_only: bool,
    /// Antialiasing. On dithers and supersamples where needed. Off uses a 256-entry lookup table.
    pub antialias: bool,
    /// Blend value 0-13 (`BlendMode`) or 14 for Overwrite.
    pub blend: u8,
    /// The dither seed. Keep it fixed for one drawing, so a re-render is identical.
    pub seed: u32,
    /// The canvas position of the buffer's top-left pixel, so a part of the canvas renders exactly
    /// as the same pixels of a whole-canvas buffer would.
    pub origin_x: u32,
    pub origin_y: u32,
}

impl Default for GradientSettings {
    fn default() -> Self {
        Self {
            shape: 0,
            repeat: 0,
            start_x: 0.0,
            start_y: 0.0,
            end_x: 0.0,
            end_y: 0.0,
            alpha_only: false,
            antialias: true,
            blend: 0,
            seed: 0,
            origin_x: 0,
            origin_y: 0,
        }
    }
}

#[wasm_bindgen]
impl GradientSettings {
    #[wasm_bindgen(constructor)]
    pub fn new() -> GradientSettings {
        Self::default()
    }
}

/// Angle of the point (`x`, `y`) seen from `start`, in turns from 0 to 1.
fn angle_turns(start: (f64, f64), x: f64, y: f64) -> f64 {
    ((y - start.1).atan2(x - start.0) + PI) / TAU
}

fn wrap_unit(value: f64) -> f64 {
    value - value.floor()
}

fn wrap_tau(value: f64) -> f64 {
    value - TAU * (value / TAU).floor()
}

/// The repeat rule of TL-ALG-GRAD applied to a shape value.
fn repeat_value(repeat: Repeat, t: f64) -> f64 {
    match repeat {
        Repeat::NoRepeat => t.clamp(0.0, 1.0),
        Repeat::Wrapped => {
            let fraction = t - t.trunc();
            if t < 0.0 {
                1.0 + fraction
            } else {
                fraction
            }
        }
        Repeat::Reflected => {
            let mut folded = t - 2.0 * (t / 2.0).trunc();
            if folded < 0.0 {
                folded += 2.0;
            }
            if folded > 1.0 {
                2.0 - folded
            } else {
                folded
            }
        }
    }
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// The straight color at `t` between `c0` and `c1` (straight RGBA, 0-255). Opaque ends mix their
/// channels directly. Otherwise the premultiplied channels mix with the alpha, and the result is
/// un-premultiplied (TL-ALG-GRAD).
fn mix(c0: [f32; 4], c1: [f32; 4], t: f32) -> [f32; 4] {
    let alpha = lerp(c0[3], c1[3], t);
    if c0[3] == 255.0 && c1[3] == 255.0 {
        return [
            lerp(c0[0], c1[0], t),
            lerp(c0[1], c1[1], t),
            lerp(c0[2], c1[2], t),
            255.0,
        ];
    }
    if alpha <= 0.0 {
        return [0.0; 4];
    }
    let mut out = [0.0_f32, 0.0, 0.0, alpha];
    for (channel, value) in out.iter_mut().take(3).enumerate() {
        let p0 = c0[channel] * c0[3] / 255.0;
        let p1 = c1[channel] * c1[3] / 255.0;
        *value = lerp(p0, p1, t) * 255.0 / alpha;
    }
    out
}

/// The shape, repeat and colors of one gradient, with the values that do not change per pixel.
struct Field {
    shape: Shape,
    repeat: Repeat,
    start: (f64, f64),
    end: (f64, f64),
    len: f64,
    len2: f64,
    c0: [f32; 4],
    c1: [f32; 4],
    alpha_only: bool,
    /// The angle of the start point seen from the end, in radians (conical repeat).
    conical_base: f64,
    /// The offset in turns that maps the end pixel to 0 (conical, no repeat).
    conical_offset: f64,
    /// Whether pixels are supersampled (TL-ALG-GRAD).
    supersample: bool,
}

impl Field {
    fn new(shape: Shape, repeat: Repeat, settings: &GradientSettings, colors: &[u8; 8]) -> Self {
        let start = (settings.start_x, settings.start_y);
        let end = (settings.end_x, settings.end_y);
        let len2 = (end.0 - start.0).powi(2) + (end.1 - start.1).powi(2);
        let len = len2.sqrt();
        let color = |at: usize| -> [f32; 4] {
            std::array::from_fn(|i| f32::from(colors[at + i]))
        };
        let shape_is_discontinuous = matches!(
            shape,
            Shape::Conical | Shape::Spiral | Shape::SpiralCounterClockwise
        );
        let mut field = Self {
            shape,
            repeat,
            start,
            end,
            len,
            len2,
            c0: color(0),
            c1: color(4),
            alpha_only: settings.alpha_only,
            conical_base: (start.1 - end.1).atan2(start.0 - end.0),
            conical_offset: 0.0,
            supersample: settings.antialias
                && (repeat != Repeat::NoRepeat || shape_is_discontinuous || len < SUPERSAMPLE_LENGTH),
        };
        let end_pixel = (end.0.floor() + 0.5, end.1.floor() + 0.5);
        field.conical_offset = -angle_turns(start, end_pixel.0, end_pixel.1);
        field
    }

    /// The shape value at a point in canvas pixels, before the repeat rule (TL-ALG-GRAD).
    fn shape_value(&self, x: f64, y: f64) -> f64 {
        let (dx, dy) = (x - self.start.0, y - self.start.1);
        let (ex, ey) = (self.end.0 - self.start.0, self.end.1 - self.start.1);
        let along = (dx * ex + dy * ey) / self.len2;
        match self.shape {
            Shape::LinearClamped => along,
            Shape::LinearReflected => along.abs(),
            Shape::LinearDiamond => along.abs() + ((dx * ey - dy * ex) / self.len2).abs(),
            Shape::Radial => dx.hypot(dy) / self.len,
            Shape::Conical => match self.repeat {
                Repeat::NoRepeat => wrap_unit(angle_turns(self.start, x, y) + self.conical_offset),
                _ => (dy.atan2(dx) - self.conical_base) / PI,
            },
            Shape::Spiral | Shape::SpiralCounterClockwise => {
                let a = dy.atan2(dx);
                let b = ey.atan2(ex);
                let theta = if self.shape == Shape::Spiral {
                    (PI - a) - (PI - b)
                } else {
                    a - b
                };
                let theta = wrap_tau(theta);
                let radial = dx.hypot(dy) / self.len;
                if self.repeat == Repeat::Reflected {
                    theta / PI + radial
                } else {
                    theta / TAU + radial
                }
            }
        }
    }

    /// The shape value after the repeat rule, in 0 to 1 for the rule's range.
    fn t(&self, x: f64, y: f64) -> f64 {
        repeat_value(self.repeat, self.shape_value(x, y))
    }

    /// The straight color (or, in transparency mode, the alpha) at the gradient position `t`.
    fn value(&self, t: f64) -> [f32; 4] {
        let t = t as f32;
        if self.alpha_only {
            [0.0, 0.0, 0.0, lerp(self.c0[3], self.c1[3], t)]
        } else {
            mix(self.c0, self.c1, t)
        }
    }

    /// Adds the values of a square of `size` pixels around (`x`, `y`) to `acc`. The square is split
    /// into quadrants while the shape values at its samples differ by more than the threshold.
    fn gather(&self, x: f64, y: f64, size: f64, depth: u32, acc: &mut Accumulator) {
        let q = size / 4.0;
        let offsets = [(-q, -q), (q, -q), (-q, q), (q, q)];
        let center = self.t(x, y);
        let (lo, hi) = offsets.iter().fold((center, center), |(lo, hi), &(dx, dy)| {
            let t = self.t(x + dx, y + dy);
            (lo.min(t), hi.max(t))
        });
        if depth < MAX_DEPTH && hi - lo > SUBDIVIDE_SPREAD {
            for (dx, dy) in offsets {
                self.gather(x + dx, y + dy, size / 2.0, depth + 1, acc);
            }
            return;
        }
        acc.add(self.value(center), (size * size) as f32);
    }
}

/// The weighted sum of straight colors, kept premultiplied so that averaging does not darken edges.
#[derive(Default)]
struct Accumulator {
    /// Premultiplied RGB, each channel times alpha, weighted.
    rgb: [f32; 3],
    /// Alpha, weighted.
    alpha: f32,
    weight: f32,
}

impl Accumulator {
    fn add(&mut self, value: [f32; 4], weight: f32) {
        for (sum, channel) in self.rgb.iter_mut().zip(value) {
            *sum += channel * value[3] / 255.0 * weight;
        }
        self.alpha += value[3] * weight;
        self.weight += weight;
    }

    /// The average as a straight color.
    fn mean(&self) -> [f32; 4] {
        let alpha = self.alpha / self.weight;
        if alpha <= 0.0 {
            return [0.0; 4];
        }
        let rgb = self.rgb.map(|sum| sum / self.weight * 255.0 / alpha);
        [rgb[0], rgb[1], rgb[2], alpha]
    }
}

/// A per-pixel value in -0.5 to 0.5 from a hash of the seed, the pixel and the channel (TL-ALG-GRAD).
/// The hash is a murmur-style finalizer, so the same drawing dithers the same way every time.
fn dither_noise(seed: u32, x: usize, y: usize, channel: u32) -> f32 {
    let mut h = seed
        ^ (x as u32).wrapping_mul(0x9E37_79B1)
        ^ (y as u32).wrapping_mul(0x85EB_CA77)
        ^ channel.wrapping_mul(0xC2B2_AE3D);
    h ^= h >> 16;
    h = h.wrapping_mul(0x85EB_CA6B);
    h ^= h >> 13;
    h = h.wrapping_mul(0xC2B2_AE35);
    h ^= h >> 16;
    (h >> 8) as f32 / 16_777_216.0 - 0.5
}

/// Rounds one channel to a byte after adding its dither (round half up).
fn to_byte(value: f32, noise: f32) -> u8 {
    (value + noise + 0.5).floor().clamp(0.0, 255.0) as u8
}

/// The lookup-table index of a gradient position, for the aliased path.
fn lut_index(t: f64) -> usize {
    (t * 255.0 + 0.5).floor().clamp(0.0, 255.0) as usize
}

/// Applies one source pixel to the destination. In transparency mode the color is kept, and the
/// alpha is replaced by Overwrite or multiplied by the gradient alpha for the other blend modes.
fn composite(pixel: [u8; 4], src: [u8; 4], alpha_only: bool, paint: Paint) -> [u8; 4] {
    if !alpha_only {
        return paint_pixel(pixel, 255, src, paint);
    }
    let alpha = if paint == Paint::Overwrite {
        src[3]
    } else {
        mul(u32::from(pixel[3]), u32::from(src[3])) as u8
    };
    [pixel[0], pixel[1], pixel[2], alpha]
}

/// Paints the gradient over the straight-alpha RGBA8 buffer `dst` of `width` × `height` pixels
/// (TL-ALG-GRAD). `colors` holds the start color and the end color as RGBA. In transparency mode
/// their alpha values are the ends of the alpha ramp. A gradient whose start equals its end leaves
/// the buffer unchanged.
pub fn gradient(
    dst: &mut [u8],
    width: usize,
    height: usize,
    colors: &[u8; 8],
    settings: &GradientSettings,
) -> Result<(), String> {
    if dst.len() != width * height * 4 {
        return Err("gradient target must be width × height RGBA8".to_owned());
    }
    let shape = Shape::try_from(settings.shape)
        .map_err(|id| format!("unknown gradient shape {id}"))?;
    let repeat = Repeat::try_from(settings.repeat)
        .map_err(|id| format!("unknown repeat type {id}"))?;
    let paint = paint_for(settings.blend)?;
    let points = [settings.start_x, settings.start_y, settings.end_x, settings.end_y];
    if !points.iter().all(|value| value.is_finite()) {
        return Err("gradient points must be finite".to_owned());
    }
    let field = Field::new(shape, repeat, settings, colors);
    if field.len2 == 0.0 {
        return Ok(());
    }
    let lut: Option<Vec<[u8; 4]>> = (!settings.antialias).then(|| {
        (0..256)
            .map(|i| {
                let value = field.value(i as f64 / 255.0);
                std::array::from_fn(|c| to_byte(value[c], 0.0))
            })
            .collect()
    });
    let (origin_x, origin_y) = (settings.origin_x as usize, settings.origin_y as usize);
    for y in 0..height {
        for x in 0..width {
            let (canvas_x, canvas_y) = (x + origin_x, y + origin_y);
            let (cx, cy) = (canvas_x as f64 + 0.5, canvas_y as f64 + 0.5);
            let src = match &lut {
                Some(table) => table[lut_index(field.t(cx, cy))],
                None => {
                    let value = if field.supersample {
                        let mut acc = Accumulator::default();
                        field.gather(cx, cy, 1.0, 0, &mut acc);
                        acc.mean()
                    } else {
                        field.value(field.t(cx, cy))
                    };
                    std::array::from_fn(|c| {
                        to_byte(
                            value[c],
                            dither_noise(settings.seed, canvas_x, canvas_y, c as u32),
                        )
                    })
                }
            };
            let i = (y * width + x) * 4;
            let pixel: [u8; 4] = dst[i..i + 4].try_into().expect("four bytes per pixel");
            dst[i..i + 4].copy_from_slice(&composite(pixel, src, field.alpha_only, paint));
        }
    }
    Ok(())
}

/// Paints a gradient over a straight-alpha RGBA8 buffer in place (see `gradient`). `colors` holds the
/// start color and the end color as eight bytes, RGBA each.
#[wasm_bindgen]
pub fn gradient_rgba8(
    dst: &mut [u8],
    width: u32,
    height: u32,
    colors: &[u8],
    settings: &GradientSettings,
) -> Result<(), JsError> {
    let colors = <[u8; 8]>::try_from(colors)
        .map_err(|_| JsError::new("a gradient needs a start and an end RGBA color"))?;
    gradient(dst, width as usize, height as usize, &colors, settings)
        .map_err(|message| JsError::new(&message))
}

#[cfg(test)]
mod tests {
    use super::*;

    const RED_BLUE: [u8; 8] = [255, 0, 0, 255, 0, 0, 255, 255];

    fn settings(shape: u8, repeat: u8, end_x: f64) -> GradientSettings {
        GradientSettings {
            shape,
            repeat,
            end_x,
            antialias: false,
            ..GradientSettings::default()
        }
    }

    fn blank(width: usize, height: usize, color: [u8; 4]) -> Vec<u8> {
        color.repeat(width * height)
    }

    fn pixel(buffer: &[u8], width: usize, x: usize, y: usize) -> [u8; 4] {
        let i = (y * width + x) * 4;
        [buffer[i], buffer[i + 1], buffer[i + 2], buffer[i + 3]]
    }

    fn field(shape: Shape, repeat: Repeat, settings: &GradientSettings) -> Field {
        Field::new(shape, repeat, settings, &RED_BLUE)
    }

    fn approx(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn a_linear_ramp_runs_from_the_start_color_to_the_end_color() {
        let mut dst = blank(10, 1, [0, 0, 0, 0]);
        gradient(&mut dst, 10, 1, &RED_BLUE, &settings(0, 0, 10.0)).expect("gradient");
        let first = pixel(&dst, 10, 0, 0);
        let last = pixel(&dst, 10, 9, 0);
        assert!(first[0] > 230 && first[2] < 30, "first {first:?}");
        assert!(last[2] > 225 && last[0] < 30, "last {last:?}");
        for x in 1..10 {
            assert!(pixel(&dst, 10, x, 0)[0] <= pixel(&dst, 10, x - 1, 0)[0]);
        }
    }

    #[test]
    fn a_clamped_ramp_holds_the_end_colors_beyond_the_line() {
        let mut dst = blank(12, 1, [9, 9, 9, 0]);
        let mut s = settings(0, 0, 8.0);
        s.start_x = 4.0;
        gradient(&mut dst, 12, 1, &RED_BLUE, &s).expect("gradient");
        assert_eq!(pixel(&dst, 12, 0, 0), [255, 0, 0, 255]);
        assert_eq!(pixel(&dst, 12, 11, 0), [0, 0, 255, 255]);
    }

    #[test]
    fn reflected_mirrors_the_ramp_about_the_start() {
        let mut dst = blank(10, 1, [0, 0, 0, 0]);
        let mut s = settings(1, 0, 10.0);
        s.start_x = 5.0;
        gradient(&mut dst, 10, 1, &RED_BLUE, &s).expect("gradient");
        assert_eq!(pixel(&dst, 10, 0, 0), pixel(&dst, 10, 9, 0));
        assert_eq!(pixel(&dst, 10, 1, 0), pixel(&dst, 10, 8, 0));
    }

    #[test]
    fn a_wrapped_repeat_repeats_the_ramp_every_length() {
        let mut dst = blank(8, 1, [0, 0, 0, 0]);
        gradient(&mut dst, 8, 1, &RED_BLUE, &settings(0, 1, 4.0)).expect("gradient");
        for x in 0..4 {
            assert_eq!(pixel(&dst, 8, x, 0), pixel(&dst, 8, x + 4, 0), "pixel {x}");
        }
    }

    #[test]
    fn a_reflected_repeat_folds_the_ramp_back() {
        let mut dst = blank(8, 1, [0, 0, 0, 0]);
        gradient(&mut dst, 8, 1, &RED_BLUE, &settings(0, 2, 4.0)).expect("gradient");
        assert_eq!(pixel(&dst, 8, 3, 0), pixel(&dst, 8, 4, 0));
        assert_eq!(pixel(&dst, 8, 0, 0), pixel(&dst, 8, 7, 0));
    }

    #[test]
    fn the_repeat_rules_follow_the_spec_formulas() {
        assert!(approx(repeat_value(Repeat::NoRepeat, -3.0), 0.0));
        assert!(approx(repeat_value(Repeat::NoRepeat, 4.0), 1.0));
        assert!(approx(repeat_value(Repeat::Wrapped, -0.25), 0.75));
        assert!(approx(repeat_value(Repeat::Wrapped, 2.25), 0.25));
        assert!(approx(repeat_value(Repeat::Reflected, 1.5), 0.5));
        assert!(approx(repeat_value(Repeat::Reflected, 2.5), 0.5));
        assert!(approx(repeat_value(Repeat::Reflected, -0.5), 0.5));
    }

    #[test]
    fn radial_and_diamond_values_follow_the_formulas() {
        let s = settings(3, 0, 10.0);
        assert!(approx(field(Shape::Radial, Repeat::NoRepeat, &s).shape_value(0.0, 10.0), 1.0));
        assert!(approx(field(Shape::LinearDiamond, Repeat::NoRepeat, &s).shape_value(0.0, 10.0), 1.0));
        assert!(approx(field(Shape::LinearDiamond, Repeat::NoRepeat, &s).shape_value(5.0, 5.0), 1.0));
    }

    #[test]
    fn a_conical_gradient_is_zero_at_the_end_pixel_without_repeat() {
        let mut s = settings(4, 0, 10.5);
        s.end_y = 0.5;
        let conical = field(Shape::Conical, Repeat::NoRepeat, &s);
        assert_eq!(conical.shape_value(10.5, 0.5), 0.0);
    }

    #[test]
    fn the_spiral_directions_turn_opposite_ways() {
        let s = settings(5, 0, 10.0);
        let clockwise = field(Shape::Spiral, Repeat::NoRepeat, &s).shape_value(0.0, 10.0);
        let counter = field(Shape::SpiralCounterClockwise, Repeat::NoRepeat, &s).shape_value(0.0, 10.0);
        assert!(approx(counter, 1.25), "counterclockwise {counter}");
        assert!(approx(clockwise, 1.75), "clockwise {clockwise}");
    }

    #[test]
    fn transparency_mode_ramps_the_alpha_and_keeps_the_color() {
        let mut dst = blank(10, 1, [255, 255, 255, 255]);
        let colors = [10, 20, 30, 0, 200, 100, 50, 255];
        let mut s = settings(0, 0, 10.0);
        s.alpha_only = true;
        gradient(&mut dst, 10, 1, &colors, &s).expect("gradient");
        let first = pixel(&dst, 10, 0, 0);
        let last = pixel(&dst, 10, 9, 0);
        assert_eq!(&first[..3], &[255, 255, 255]);
        assert_eq!(&last[..3], &[255, 255, 255]);
        assert!(first[3] > 0 && first[3] < last[3], "{first:?} {last:?}");
        assert!(last[3] > 200);
    }

    #[test]
    fn transparency_overwrite_replaces_the_alpha() {
        let mut dst = blank(10, 1, [9, 9, 9, 128]);
        let colors = [10, 20, 30, 0, 200, 100, 50, 255];
        let mut s = settings(0, 0, 10.0);
        s.alpha_only = true;
        s.blend = 14;
        gradient(&mut dst, 10, 1, &colors, &s).expect("gradient");
        assert_eq!(pixel(&dst, 10, 0, 0), [9, 9, 9, 13]);
    }

    #[test]
    fn color_overwrite_replaces_the_destination() {
        let mut dst = blank(12, 1, [9, 9, 9, 0]);
        let mut s = settings(0, 0, 8.0);
        s.start_x = 2.0;
        s.blend = 14;
        gradient(&mut dst, 12, 1, &RED_BLUE, &s).expect("gradient");
        assert_eq!(pixel(&dst, 12, 0, 0), [255, 0, 0, 255]);
    }

    #[test]
    fn multiply_darkens_the_destination() {
        let mut dst = blank(12, 1, [200, 100, 50, 255]);
        let mut s = settings(0, 0, 8.0);
        s.start_x = 2.0;
        s.blend = 1;
        gradient(&mut dst, 12, 1, &RED_BLUE, &s).expect("gradient");
        assert_eq!(pixel(&dst, 12, 0, 0), [200, 0, 0, 255]);
    }

    #[test]
    fn a_zero_length_gradient_leaves_the_buffer_unchanged() {
        let mut dst = blank(4, 4, [1, 2, 3, 4]);
        let before = dst.clone();
        let mut s = settings(0, 0, 0.0);
        s.start_x = 0.0;
        gradient(&mut dst, 4, 4, &RED_BLUE, &s).expect("gradient");
        assert_eq!(dst, before);
    }

    #[test]
    fn antialiasing_dithers_and_is_repeatable() {
        let mut first = blank(24, 24, [0, 0, 0, 0]);
        let mut second = blank(24, 24, [0, 0, 0, 0]);
        let mut aliased = blank(24, 24, [0, 0, 0, 0]);
        let mut s = settings(4, 0, 12.0);
        s.antialias = true;
        s.seed = 7;
        gradient(&mut first, 24, 24, &RED_BLUE, &s).expect("gradient");
        gradient(&mut second, 24, 24, &RED_BLUE, &s).expect("gradient");
        assert_eq!(first, second);
        s.antialias = false;
        gradient(&mut aliased, 24, 24, &RED_BLUE, &s).expect("gradient");
        assert_ne!(first, aliased);
    }

    #[test]
    fn a_part_rendered_at_its_origin_equals_the_same_part_of_the_whole() {
        let base: Vec<u8> = (0..40 * 30 * 4).map(|i| (i * 7 % 256) as u8).collect();
        for (shape, antialias) in [(0, true), (3, true), (5, false), (4, true)] {
            let mut s = settings(shape, 2, 17.0);
            s.start_x = 6.5;
            s.start_y = 9.25;
            s.end_y = 21.0;
            s.antialias = antialias;
            s.seed = 11;
            let mut whole = base.clone();
            gradient(&mut whole, 40, 30, &RED_BLUE, &s).expect("gradient");
            let (left, top, width, height) = (13, 7, 19, 15);
            let mut part: Vec<u8> = (0..height)
                .flat_map(|y| {
                    let from = ((top + y) * 40 + left) * 4;
                    base[from..from + width * 4].to_vec()
                })
                .collect();
            s.origin_x = left as u32;
            s.origin_y = top as u32;
            gradient(&mut part, width, height, &RED_BLUE, &s).expect("gradient");
            for y in 0..height {
                let from = ((top + y) * 40 + left) * 4;
                assert_eq!(
                    &part[y * width * 4..(y + 1) * width * 4],
                    &whole[from..from + width * 4],
                    "shape {shape} row {y}"
                );
            }
        }
    }

    #[test]
    fn the_dither_stays_within_half_a_level() {
        for x in 0..40 {
            for y in 0..40 {
                for channel in 0..4 {
                    let noise = dither_noise(3, x, y, channel);
                    assert!((-0.5..0.5).contains(&noise), "{noise}");
                }
            }
        }
    }

    #[test]
    fn supersampling_follows_the_spec_conditions() {
        let long_linear = settings(0, 0, 40.0);
        let mut antialiased = long_linear;
        antialiased.antialias = true;
        assert!(!field(Shape::LinearClamped, Repeat::NoRepeat, &antialiased).supersample);
        assert!(field(Shape::LinearClamped, Repeat::Wrapped, &antialiased).supersample);
        assert!(field(Shape::Conical, Repeat::NoRepeat, &antialiased).supersample);
        assert!(field(Shape::Spiral, Repeat::NoRepeat, &antialiased).supersample);
        let mut short = antialiased;
        short.end_x = 4.0;
        assert!(field(Shape::LinearClamped, Repeat::NoRepeat, &short).supersample);
        let mut aliased = antialiased;
        aliased.antialias = false;
        assert!(!field(Shape::Conical, Repeat::NoRepeat, &aliased).supersample);
    }

    #[test]
    fn bad_input_is_an_error() {
        let mut dst = blank(2, 2, [0, 0, 0, 0]);
        assert!(gradient(&mut dst[..7], 2, 2, &RED_BLUE, &settings(0, 0, 4.0)).is_err());
        assert!(gradient(&mut dst, 2, 2, &RED_BLUE, &settings(9, 0, 4.0)).is_err());
        assert!(gradient(&mut dst, 2, 2, &RED_BLUE, &settings(0, 7, 4.0)).is_err());
        let mut blend = settings(0, 0, 4.0);
        blend.blend = 99;
        assert!(gradient(&mut dst, 2, 2, &RED_BLUE, &blend).is_err());
        let mut nan = settings(0, 0, 4.0);
        nan.start_x = f64::NAN;
        assert!(gradient(&mut dst, 2, 2, &RED_BLUE, &nan).is_err());
    }
}
