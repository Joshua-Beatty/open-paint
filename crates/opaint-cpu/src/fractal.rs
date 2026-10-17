//! Julia and Mandelbrot fractals (FX-RENDER-JULIA-01, FX-RENDER-MANDEL-01). Each pixel averages `q²`
//! rotated-grid samples (FX-SHARED-QUALITY). The average is held as a 16-bit premultiplied texel, then
//! unpremultiplied and composited onto the layer with a blend mode (`mix.rs`). The WGSL twin in
//! `packages/effects/src/fractal-wgsl.ts` runs the same expressions in one pass and rounds the average
//! to the same 16-bit steps in registers.
//!
//! The host computes every division (the reciprocals of the document height and of Zoom, and the
//! aspect) and sends it in the plan. The orbit then uses only multiplication, addition and subtraction,
//! which both backends round the same way. A WGSL division is only accurate to 2.5 ulp, and a single
//! ulp in an orbit grows to a different escape count near the fractal's edge.

use crate::distort::rgss_offsets;
use crate::mix::{MixMode, mix_rgba8};

/// The Julia constant `c` (FX-RENDER-JULIA-01).
const JULIA_C: [f32; 2] = [0.3125, 0.03];
const JULIA_MAX_ITER: u32 = 256;
const JULIA_ESCAPE: f32 = 10_000.0;
/// `ln(10000)`, the smooth-count constant of Julia.
const LN_JULIA_ESCAPE: f32 = 9.21034;
/// The Mandelbrot offset of `c` (FX-RENDER-MANDEL-01).
const MANDEL_OFFSET: [f32; 2] = [-0.7, -0.29];
/// The Mandelbrot iteration budget: iterate while `n · Factor < 1024`.
const MANDEL_BUDGET: f32 = 1024.0;
const MANDEL_ESCAPE: f32 = 100_000.0;
/// `ln(100000)`, the smooth-count constant of Mandelbrot.
const LN_MANDEL_ESCAPE: f32 = 11.512_925;
/// Zoom is clamped to at least this (FX-RENDER-JULIA-01). The host applies the clamp, and the plan
/// reader checks it.
const MIN_ZOOM: f32 = 0.0001;
/// The largest value of a 16-bit channel.
const CHANNEL_16: f32 = 65_535.0;

/// Parameters shared by Julia and Mandelbrot, as the host computes them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FractalParams {
    /// The region's top-left corner in document pixels.
    pub origin: (u32, u32),
    /// The document size in pixels.
    pub document: (u32, u32),
    /// Factor, 1..=10: the scale of the iteration count.
    pub factor: f32,
    /// The cosine and sine of the Angle, so both backends rotate with the same two values.
    pub rotation: [f32; 2],
    /// `1 / H`, the scale of the view coordinate.
    pub inv_height: f32,
    /// `H / W`, the Julia aspect.
    pub aspect: f32,
    /// `1 / Zoom`, with Zoom clamped to at least 0.0001.
    pub inv_zoom: f32,
    /// Quality, 1..=8: `q²` samples per pixel.
    pub quality: u8,
    pub mode: MixMode,
}

impl FractalParams {
    /// Reads the twelve values the host sends: origin x and y, document width and height, Factor, the
    /// cosine and sine of the Angle, the reciprocal of the height, the aspect, the reciprocal of Zoom,
    /// Quality and the blend mode code.
    pub fn from_plan(plan: &[f32]) -> Result<Self, String> {
        let [
            ox,
            oy,
            dw,
            dh,
            factor,
            cos,
            sin,
            inv_height,
            aspect,
            inv_zoom,
            quality,
            mode,
        ] = <[f32; 12]>::try_from(plan)
            .map_err(|_| format!("fractal plan needs 12 values, got {}", plan.len()))?;
        if !(1.0..=10.0).contains(&factor) {
            return Err(format!("factor must be 1..=10, got {factor}"));
        }
        if !cos.is_finite() || !sin.is_finite() {
            return Err(format!("the angle's cosine and sine must be finite, got {cos} {sin}"));
        }
        if !(inv_height.is_finite() && inv_height > 0.0) {
            return Err(format!("the inverse height must be positive, got {inv_height}"));
        }
        if !(aspect.is_finite() && aspect > 0.0) {
            return Err(format!("the aspect must be positive, got {aspect}"));
        }
        if !(inv_zoom.is_finite() && inv_zoom > 0.0 && inv_zoom <= 1.0 / MIN_ZOOM) {
            return Err(format!("the inverse zoom must be 0 to {}, got {inv_zoom}", 1.0 / MIN_ZOOM));
        }
        if !(1.0..=8.0).contains(&quality) || quality.fract() != 0.0 {
            return Err(format!("quality must be an integer 1..=8, got {quality}"));
        }
        if !(0.0..=45.0).contains(&mode) || mode.fract() != 0.0 {
            return Err(format!("mix mode must be an integer 0..=45, got {mode}"));
        }
        let mode = MixMode::try_from(mode as u8).map_err(|code| format!("mix mode {code}"))?;
        Ok(Self {
            origin: (ox as u32, oy as u32),
            document: (dw as u32, dh as u32),
            factor,
            rotation: [cos, sin],
            inv_height,
            aspect,
            inv_zoom,
            quality: quality as u8,
            mode,
        })
    }
}

/// Reads a Mandelbrot plan: the twelve Julia values, then Invert Colors as 0 or 1.
pub fn mandelbrot_from_plan(plan: &[f32]) -> Result<(FractalParams, bool), String> {
    let [frame @ .., invert] = plan else {
        return Err("mandelbrot plan needs 13 values, got 0".to_string());
    };
    let params = FractalParams::from_plan(frame)?;
    Ok((params, *invert != 0.0))
}

/// The rotated view coordinate of a document position (FX-RENDER-JULIA-01): `uv = (2·pos − size) / H`,
/// turned by the angle. The turn is the rotation matrix of the angle's cosine and sine, which is the
/// polar form `(|uv| cos(atan2 + θ), |uv| sin(atan2 + θ))` without the per-pixel transcendentals.
fn view(pos: [f32; 2], params: &FractalParams) -> [f32; 2] {
    let (w, h) = (params.document.0 as f32, params.document.1 as f32);
    let uv = [
        (2.0 * pos[0] - w) * params.inv_height,
        (2.0 * pos[1] - h) * params.inv_height,
    ];
    let [cos, sin] = params.rotation;
    [uv[0] * cos - uv[1] * sin, uv[0] * sin + uv[1] * cos]
}

fn saturate(rgba: [f32; 4]) -> [f32; 4] {
    rgba.map(|c| c.clamp(0.0, 1.0))
}

/// The straight RGBA of one Julia sample at a document position (FX-RENDER-JULIA-01).
fn julia_color(pos: [f32; 2], params: &FractalParams) -> [f32; 4] {
    let uv = view(pos, params);
    let mut z = [
        (uv[0] - uv[1] * params.aspect) * params.inv_zoom,
        (uv[1] + uv[0] * params.aspect) * params.inv_zoom,
    ];
    let mut n = 0u32;
    while n < JULIA_MAX_ITER && z[0] * z[0] + z[1] * z[1] < JULIA_ESCAPE {
        z = [
            z[0] * z[0] - z[1] * z[1] + JULIA_C[0],
            2.0 * z[0] * z[1] + JULIA_C[1],
        ];
        n += 1;
    }
    let r2 = z[0] * z[0] + z[1] * z[1];
    let ln_r2 = if r2 > 0.0 { r2.ln() } else { 0.0 };
    let smooth = if ln_r2 == 0.0 {
        n as f32
    } else {
        n as f32 - (2.0 - 2.0 * LN_JULIA_ESCAPE / ln_r2)
    };
    let v = params.factor * smooth / 256.0;
    saturate([v - 1.0, v - 2.0, v - 3.0, v])
}

/// The straight RGBA of one Mandelbrot sample at a document position (FX-RENDER-MANDEL-01).
fn mandelbrot_color(pos: [f32; 2], params: &FractalParams, invert: bool) -> [f32; 4] {
    let uv = view(pos, params);
    let c = [
        uv[0] * params.inv_zoom + MANDEL_OFFSET[0],
        uv[1] * params.inv_zoom + MANDEL_OFFSET[1],
    ];
    let mut z = [0.0f32, 0.0];
    let mut n = 0u32;
    while (n as f32 * params.factor) < MANDEL_BUDGET && z[0] * z[0] + z[1] * z[1] < MANDEL_ESCAPE {
        z = [z[0] * z[0] - z[1] * z[1] + c[0], 2.0 * z[0] * z[1] + c[1]];
        n += 1;
    }
    let r2 = z[0] * z[0] + z[1] * z[1];
    let ln_r2 = if r2 > 0.0 { r2.ln() } else { 0.0 };
    let m = n as f32 - ln_r2 / LN_MANDEL_ESCAPE;
    let v = (64.0 + params.factor * m) / 256.0;
    let mut rgba = saturate([v - 3.0, v - 2.0, v - 1.0, v]);
    if invert {
        for channel in &mut rgba[..3] {
            *channel = 1.0 - *channel;
        }
    }
    rgba
}

/// Rounds a premultiplied channel in `0..=1` to a 16-bit step (the intermediate target).
fn to_16(value: f32) -> u16 {
    (value.clamp(0.0, 1.0) * CHANNEL_16 + 0.5).floor() as u16
}

/// Unpremultiplies a 16-bit premultiplied texel to straight RGBA on `0..=1`.
fn unpremultiply(texel: [u16; 4]) -> [f32; 4] {
    if texel[3] == 0 {
        return [0.0; 4];
    }
    let alpha = f32::from(texel[3]) / CHANNEL_16;
    let channel = |i: usize| ((f32::from(texel[i]) / CHANNEL_16) / alpha).clamp(0.0, 1.0);
    [channel(0), channel(1), channel(2), alpha]
}

/// The region's straight RGBA (`width` pixels per row): `q²` rotated-grid samples per pixel, averaged
/// in premultiplied form into 16-bit texels.
fn supersampled(
    width: usize,
    height: usize,
    params: &FractalParams,
    sample: impl Fn([f32; 2]) -> [f32; 4],
) -> Result<Vec<[f32; 4]>, String> {
    let offsets = rgss_offsets(params.quality)?;
    let count = offsets.len() as f32;
    let (ox, oy) = (params.origin.0 as f32, params.origin.1 as f32);
    let mut out = Vec::with_capacity(width * height);
    for y in 0..height {
        for x in 0..width {
            let mut sum = [0.0f32; 4];
            for offset in &offsets {
                let pos = [
                    ox + x as f32 + 0.5 + offset[0],
                    oy + y as f32 + 0.5 + offset[1],
                ];
                let c = sample(pos);
                let premultiplied = [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]];
                for (total, part) in sum.iter_mut().zip(premultiplied) {
                    *total += part;
                }
            }
            let texel = sum.map(|total| to_16(total / count));
            out.push(unpremultiply(texel));
        }
    }
    Ok(out)
}

/// The Julia image of a region, straight RGBA on 0..=1 (FX-RENDER-JULIA-01).
pub fn julia_image(
    width: usize,
    height: usize,
    params: &FractalParams,
) -> Result<Vec<[f32; 4]>, String> {
    supersampled(width, height, params, |pos| julia_color(pos, params))
}

/// The Mandelbrot image of a region, straight RGBA on 0..=1 (FX-RENDER-MANDEL-01).
pub fn mandelbrot_image(
    width: usize,
    height: usize,
    params: &FractalParams,
    invert: bool,
) -> Result<Vec<[f32; 4]>, String> {
    supersampled(width, height, params, |pos| {
        mandelbrot_color(pos, params, invert)
    })
}

/// Julia (FX-RENDER-JULIA-01) composited onto `src` (straight RGBA8) with the blend mode.
pub fn julia_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    params: &FractalParams,
) -> Result<Vec<u8>, String> {
    let image = julia_image(width, height, params)?;
    mix_rgba8(src, &image, width, params.mode)
}

/// Mandelbrot (FX-RENDER-MANDEL-01) composited onto `src` (straight RGBA8) with the blend mode.
pub fn mandelbrot_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    params: &FractalParams,
    invert: bool,
) -> Result<Vec<u8>, String> {
    let image = mandelbrot_image(width, height, params, invert)?;
    mix_rgba8(src, &image, width, params.mode)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(width: u32, height: u32, quality: u8) -> FractalParams {
        FractalParams {
            origin: (0, 0),
            document: (width, height),
            factor: 4.0,
            rotation: [1.0, 0.0],
            inv_height: 1.0 / height as f32,
            aspect: height as f32 / width as f32,
            inv_zoom: 1.0,
            quality,
            mode: MixMode::Overwrite,
        }
    }

    fn assert_unit(image: &[[f32; 4]]) {
        for px in image {
            for c in px {
                assert!((0.0..=1.0).contains(c), "{px:?}");
            }
        }
    }

    /// The ten-value Julia plan of a 40 x 24 document, at Factor 4, Zoom 1, no angle, Quality 3.
    fn plan_of_40_by_24() -> [f32; 12] {
        [
            0.0,
            0.0,
            40.0,
            24.0,
            4.0,
            1.0,
            0.0,
            1.0 / 24.0,
            24.0 / 40.0,
            1.0,
            3.0,
            2.0,
        ]
    }

    #[test]
    fn the_intermediate_target_holds_16_bit_steps() {
        assert_eq!(to_16(0.0), 0);
        assert_eq!(to_16(0.5), 32_768);
        assert_eq!(to_16(1.0), 65_535);
        assert_eq!(to_16(2.0), 65_535);
    }

    #[test]
    fn the_plan_round_trips_and_rejects_bad_values() {
        let plan = plan_of_40_by_24();
        let read = FractalParams::from_plan(&plan).expect("valid plan");
        assert_eq!(read.document, (40, 24));
        assert_eq!(read.quality, 3);
        assert_eq!(read.mode, MixMode::Overwrite);
        assert!(FractalParams::from_plan(&plan[..11]).is_err());
        let mut bad = plan;
        bad[4] = 11.0;
        assert!(FractalParams::from_plan(&bad).is_err());
        let mut bad = plan;
        bad[5] = f32::NAN;
        assert!(FractalParams::from_plan(&bad).is_err());
        let mut bad = plan;
        bad[7] = 0.0;
        assert!(FractalParams::from_plan(&bad).is_err());
        let mut bad = plan;
        bad[9] = 0.0;
        assert!(FractalParams::from_plan(&bad).is_err());
        let mut bad = plan;
        bad[10] = 9.0;
        assert!(FractalParams::from_plan(&bad).is_err());
        let mut bad = plan;
        bad[11] = 46.0;
        assert!(FractalParams::from_plan(&bad).is_err());
    }

    #[test]
    fn the_inverse_zoom_may_not_pass_the_minimum_zoom() {
        let mut plan = plan_of_40_by_24();
        plan[9] = 1.0 / MIN_ZOOM;
        assert!(FractalParams::from_plan(&plan).is_ok());
        plan[9] = 2.0 / MIN_ZOOM;
        assert!(FractalParams::from_plan(&plan).is_err());
    }

    #[test]
    fn the_mandelbrot_plan_adds_the_invert_flag() {
        let mut plan = [0.0f32; 13];
        plan[..12].copy_from_slice(&plan_of_40_by_24());
        plan[12] = 1.0;
        let (params, invert) = mandelbrot_from_plan(&plan).expect("valid plan");
        assert!(invert);
        assert_eq!(params.document, (40, 24));
        assert!(mandelbrot_from_plan(&plan[..12]).is_err());
    }

    #[test]
    fn julia_is_deterministic_and_stays_in_range() {
        let params = frame(24, 16, 1);
        let a = julia_image(24, 16, &params).expect("valid");
        let b = julia_image(24, 16, &params).expect("valid");
        assert_eq!(a, b);
        assert_unit(&a);
    }

    #[test]
    fn quality_changes_the_samples_along_the_fractal_edge() {
        let one = julia_image(24, 16, &frame(24, 16, 1)).expect("valid");
        let three = julia_image(24, 16, &frame(24, 16, 3)).expect("valid");
        assert_ne!(one, three);
    }

    #[test]
    fn a_region_matches_the_same_pixels_of_the_document() {
        let whole = julia_image(20, 12, &frame(20, 12, 2)).expect("valid");
        let region = julia_image(
            4,
            3,
            &FractalParams {
                origin: (5, 7),
                ..frame(20, 12, 2)
            },
        )
        .expect("valid");
        for y in 0..3 {
            for x in 0..4 {
                assert_eq!(region[y * 4 + x], whole[(y + 7) * 20 + x + 5]);
            }
        }
    }

    #[test]
    fn a_point_inside_the_main_cardioid_is_opaque_white() {
        // Pixel (60, 64) of a 100-pixel square has c = (-0.49, 0), inside the main cardioid. Its orbit
        // stays bounded, so the budget runs out and the smooth count is large.
        let params = frame(100, 100, 1);
        let image = mandelbrot_image(100, 100, &params, false).expect("valid");
        assert_eq!(image[64 * 100 + 60], [1.0, 1.0, 1.0, 1.0]);
    }

    #[test]
    fn invert_colors_turns_rgb_around_and_keeps_alpha() {
        let params = frame(24, 16, 2);
        let plain = mandelbrot_image(24, 16, &params, false).expect("valid");
        let inverted = mandelbrot_image(24, 16, &params, true).expect("valid");
        let mut opaque = 0;
        for (a, b) in plain.iter().zip(&inverted) {
            assert_eq!(a[3], b[3]);
            if a[3] > 0.5 {
                opaque += 1;
                for c in 0..3 {
                    assert!((1.0 - a[c] - b[c]).abs() < 1e-3, "{a:?} {b:?}");
                }
            }
        }
        assert!(opaque > 0);
    }

    #[test]
    fn overwrite_replaces_the_layer_with_the_fractal() {
        let dst = vec![200u8; 24 * 16 * 4];
        let out = julia_rgba8(&dst, 24, 16, &frame(24, 16, 1)).expect("sizes match");
        assert_ne!(out, dst);
        let mirror = mandelbrot_rgba8(&dst, 24, 16, &frame(24, 16, 1), false).expect("sizes match");
        assert_ne!(mirror, dst);
    }
}
