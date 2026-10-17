//! Render blend modes (FX-SHARED-MIXMODE): how a generated image (the source) is composited
//! onto the layer (the destination). The 46 modes keep the spec's order, which is also their stored
//! code. The math runs in f32 on 0..=1 values, and the WGSL twin in `packages/effects/src/mix-wgsl.ts`
//! mirrors each expression, so the two backends agree to within one 8-bit step.

use crate::artistic::to_u8;

/// The render blend modes in the spec's order (FX-SHARED-MIXMODE). The discriminant is the code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum MixMode {
    Over = 0,
    Under,
    Overwrite,
    Multiply,
    Screen,
    Darken,
    Lighten,
    Dissolve,
    ColorBurn,
    LinearBurn,
    DarkerColor,
    LighterColor,
    ColorDodge,
    LinearDodge,
    Overlay,
    SoftLight,
    HardLight,
    VividLight,
    LinearLight,
    PinLight,
    HardMix,
    Difference,
    Exclusion,
    Hue,
    Saturation,
    Color,
    Luminosity,
    Subtract,
    Division,
    Additive,
    Reflect,
    Glow,
    Negation,
    Min,
    Max,
    In,
    DestinationIn,
    Out,
    DestinationOut,
    Atop,
    DestinationAtop,
    Plus,
    MaskInvert,
    Xor8,
    Xor16,
    XorComposite,
}

impl MixMode {
    pub const ALL: [MixMode; 46] = [
        MixMode::Over,
        MixMode::Under,
        MixMode::Overwrite,
        MixMode::Multiply,
        MixMode::Screen,
        MixMode::Darken,
        MixMode::Lighten,
        MixMode::Dissolve,
        MixMode::ColorBurn,
        MixMode::LinearBurn,
        MixMode::DarkerColor,
        MixMode::LighterColor,
        MixMode::ColorDodge,
        MixMode::LinearDodge,
        MixMode::Overlay,
        MixMode::SoftLight,
        MixMode::HardLight,
        MixMode::VividLight,
        MixMode::LinearLight,
        MixMode::PinLight,
        MixMode::HardMix,
        MixMode::Difference,
        MixMode::Exclusion,
        MixMode::Hue,
        MixMode::Saturation,
        MixMode::Color,
        MixMode::Luminosity,
        MixMode::Subtract,
        MixMode::Division,
        MixMode::Additive,
        MixMode::Reflect,
        MixMode::Glow,
        MixMode::Negation,
        MixMode::Min,
        MixMode::Max,
        MixMode::In,
        MixMode::DestinationIn,
        MixMode::Out,
        MixMode::DestinationOut,
        MixMode::Atop,
        MixMode::DestinationAtop,
        MixMode::Plus,
        MixMode::MaskInvert,
        MixMode::Xor8,
        MixMode::Xor16,
        MixMode::XorComposite,
    ];
}

impl TryFrom<u8> for MixMode {
    type Error = u8;

    fn try_from(value: u8) -> Result<Self, u8> {
        Self::ALL.get(usize::from(value)).copied().ok_or(value)
    }
}

/// The Dissolve threshold at a pixel, in [0, 1): a 32-bit integer hash of its position, so the
/// dissolve pattern is the same on both backends.
pub fn dissolve_threshold(x: u32, y: u32) -> f32 {
    let mut h = x.wrapping_mul(0x9E37_79B1) ^ y.wrapping_mul(0x85EB_CA77).wrapping_add(0x632B_E5AB);
    h ^= h >> 16;
    h = h.wrapping_mul(0x7FEB_352D);
    h ^= h >> 15;
    h = h.wrapping_mul(0x846C_A68B);
    h ^= h >> 16;
    h as f32 / 4_294_967_296.0
}

fn screen(d: f32, s: f32) -> f32 {
    d + s - d * s
}

fn hard_light(d: f32, s: f32) -> f32 {
    if s <= 0.5 {
        d * 2.0 * s
    } else {
        screen(d, 2.0 * s - 1.0)
    }
}

fn soft_light(d: f32, s: f32) -> f32 {
    if s <= 0.5 {
        d - (1.0 - 2.0 * s) * d * (1.0 - d)
    } else {
        let g = if d <= 0.25 {
            ((16.0 * d - 12.0) * d + 4.0) * d
        } else {
            d.sqrt()
        };
        d + (2.0 * s - 1.0) * (g - d)
    }
}

fn color_burn(d: f32, s: f32) -> f32 {
    if d >= 1.0 {
        1.0
    } else if s <= 0.0 {
        0.0
    } else {
        1.0 - ((1.0 - d) / s).min(1.0)
    }
}

fn color_dodge(d: f32, s: f32) -> f32 {
    if d <= 0.0 {
        0.0
    } else if s >= 1.0 {
        1.0
    } else {
        (d / (1.0 - s)).min(1.0)
    }
}

fn vivid_light(d: f32, s: f32) -> f32 {
    if s <= 0.5 {
        color_burn(d, 2.0 * s)
    } else {
        color_dodge(d, 2.0 * s - 1.0)
    }
}

/// The separable blend `f(d, s)` of one channel (W3C definitions, and the common image-editor ones
/// for the modes the W3C set does not define). Only the separable modes are passed here.
fn separable(mode: MixMode, d: f32, s: f32) -> f32 {
    use MixMode::*;
    match mode {
        Multiply => d * s,
        Screen => screen(d, s),
        Darken | Min => d.min(s),
        Lighten | Max => d.max(s),
        ColorBurn => color_burn(d, s),
        LinearBurn => (d + s - 1.0).max(0.0),
        ColorDodge => color_dodge(d, s),
        LinearDodge | Additive => (d + s).min(1.0),
        Overlay => hard_light(s, d),
        SoftLight => soft_light(d, s),
        HardLight => hard_light(d, s),
        VividLight => vivid_light(d, s),
        LinearLight => (d + 2.0 * s - 1.0).clamp(0.0, 1.0),
        PinLight => {
            if s <= 0.5 {
                d.min(2.0 * s)
            } else {
                d.max(2.0 * s - 1.0)
            }
        }
        HardMix => {
            if d + s >= 1.0 {
                1.0
            } else {
                0.0
            }
        }
        Difference => (d - s).abs(),
        Exclusion => d + s - 2.0 * d * s,
        Subtract => (d - s).max(0.0),
        Division => {
            if s <= 0.0 {
                1.0
            } else {
                (d / s).min(1.0)
            }
        }
        Reflect => {
            if s >= 1.0 {
                1.0
            } else {
                (d * d / (1.0 - s)).min(1.0)
            }
        }
        Glow => {
            if d >= 1.0 {
                1.0
            } else {
                (s * s / (1.0 - d)).min(1.0)
            }
        }
        Negation => 1.0 - (1.0 - d - s).abs(),
        _ => d,
    }
}

fn lum(c: [f32; 3]) -> f32 {
    0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
}

fn sat(c: [f32; 3]) -> f32 {
    c[0].max(c[1]).max(c[2]) - c[0].min(c[1]).min(c[2])
}

fn clip_color(c: [f32; 3]) -> [f32; 3] {
    let l = lum(c);
    let n = c[0].min(c[1]).min(c[2]);
    let x = c[0].max(c[1]).max(c[2]);
    let mut out = c;
    if n < 0.0 && l - n > 0.0 {
        out = c.map(|v| l + (v - l) * l / (l - n));
    }
    if x > 1.0 && x - l > 0.0 {
        out = out.map(|v| l + (v - l) * (1.0 - l) / (x - l));
    }
    out
}

fn set_lum(c: [f32; 3], l: f32) -> [f32; 3] {
    let d = l - lum(c);
    clip_color([c[0] + d, c[1] + d, c[2] + d])
}

fn set_sat(c: [f32; 3], s: f32) -> [f32; 3] {
    let max = c[0].max(c[1]).max(c[2]);
    let min = c[0].min(c[1]).min(c[2]);
    if max > min {
        c.map(|v| (v - min) * s / (max - min))
    } else {
        [0.0; 3]
    }
}

/// The non-separable blends (W3C Compositing and Blending, plus the darker and lighter color modes).
fn non_separable(mode: MixMode, d: [f32; 3], s: [f32; 3]) -> [f32; 3] {
    use MixMode::*;
    match mode {
        DarkerColor => {
            if lum(s) < lum(d) {
                s
            } else {
                d
            }
        }
        LighterColor => {
            if lum(s) > lum(d) {
                s
            } else {
                d
            }
        }
        Hue => set_lum(set_sat(s, sat(d)), lum(d)),
        Saturation => set_lum(set_sat(d, sat(s)), lum(d)),
        Color => set_lum(s, lum(d)),
        Luminosity => set_lum(d, lum(s)),
        _ => d,
    }
}

fn per_channel(dc: [f32; 3], sc: [f32; 3], f: impl Fn(f32, f32) -> f32) -> [f32; 3] {
    [f(dc[0], sc[0]), f(dc[1], sc[1]), f(dc[2], sc[2])]
}

/// The XOR of two values quantized to `levels` steps (255 for 8 bits, 65535 for 16 bits).
fn xor_channel(d: f32, s: f32, levels: f32) -> f32 {
    let a = (d * levels + 0.5).floor() as u32;
    let b = (s * levels + 0.5).floor() as u32;
    (a ^ b) as f32 / levels
}

/// The blend composite (W3C, premultiplied): the source over the destination, with the blend
/// function `b` on the straight colors in place of the source color.
fn blend_with(d: [f32; 4], s: [f32; 4], b: impl Fn([f32; 3], [f32; 3]) -> [f32; 3]) -> [f32; 4] {
    let (sa, da) = (s[3], d[3]);
    let ra = sa + da - sa * da;
    if ra <= 0.0 {
        return [0.0; 4];
    }
    let dc = [d[0], d[1], d[2]];
    let sc = [s[0], s[1], s[2]];
    let bl = b(dc, sc);
    let mut out = [0.0, 0.0, 0.0, ra.clamp(0.0, 1.0)];
    for c in 0..3 {
        out[c] = (((1.0 - sa) * da * dc[c] + (1.0 - da) * sa * sc[c] + sa * da * bl[c]) / ra)
            .clamp(0.0, 1.0);
    }
    out
}

/// Destination-over (Under): the destination is laid over the source.
fn under(d: [f32; 4], s: [f32; 4]) -> [f32; 4] {
    let (sa, da) = (s[3], d[3]);
    let ra = da + sa * (1.0 - da);
    if ra <= 0.0 {
        return [0.0; 4];
    }
    let mut out = [0.0, 0.0, 0.0, ra.clamp(0.0, 1.0)];
    for c in 0..3 {
        out[c] = ((d[c] * da + s[c] * sa * (1.0 - da)) / ra).clamp(0.0, 1.0);
    }
    out
}

/// Converts premultiplied color `cp` with alpha `ra` back to straight RGBA.
fn unpremultiply(cp: [f32; 3], ra: f32) -> [f32; 4] {
    if ra <= 0.0 {
        return [0.0; 4];
    }
    [
        (cp[0] / ra).clamp(0.0, 1.0),
        (cp[1] / ra).clamp(0.0, 1.0),
        (cp[2] / ra).clamp(0.0, 1.0),
        ra.clamp(0.0, 1.0),
    ]
}

/// The Porter-Duff composites on premultiplied color (FX-SHARED-MIXMODE, 36-43 and 46).
fn porter_duff(mode: MixMode, d: [f32; 4], s: [f32; 4]) -> [f32; 4] {
    use MixMode::*;
    let (sa, da) = (s[3], d[3]);
    let dp = [d[0] * da, d[1] * da, d[2] * da];
    let sp = [s[0] * sa, s[1] * sa, s[2] * sa];
    let (cp, ra) = match mode {
        In => (sp.map(|v| v * da), sa * da),
        DestinationIn => (dp.map(|v| v * sa), da * sa),
        Out => (sp.map(|v| v * (1.0 - da)), sa * (1.0 - da)),
        DestinationOut | MaskInvert => (dp.map(|v| v * (1.0 - sa)), da * (1.0 - sa)),
        Atop => (
            [
                sp[0] * da + dp[0] * (1.0 - sa),
                sp[1] * da + dp[1] * (1.0 - sa),
                sp[2] * da + dp[2] * (1.0 - sa),
            ],
            sa * da + da * (1.0 - sa),
        ),
        DestinationAtop => (
            [
                dp[0] * sa + sp[0] * (1.0 - da),
                dp[1] * sa + sp[1] * (1.0 - da),
                dp[2] * sa + sp[2] * (1.0 - da),
            ],
            da * sa + sa * (1.0 - da),
        ),
        Plus => (
            [
                (sp[0] + dp[0]).min(1.0),
                (sp[1] + dp[1]).min(1.0),
                (sp[2] + dp[2]).min(1.0),
            ],
            (sa + da).min(1.0),
        ),
        XorComposite => (
            [
                sp[0] * (1.0 - da) + dp[0] * (1.0 - sa),
                sp[1] * (1.0 - da) + dp[1] * (1.0 - sa),
                sp[2] * (1.0 - da) + dp[2] * (1.0 - sa),
            ],
            sa * (1.0 - da) + da * (1.0 - sa),
        ),
        _ => (dp, da),
    };
    unpremultiply(cp, ra)
}

/// Composites one generated pixel `s` onto the layer pixel `d`, both straight RGBA on 0..=1. `x` and
/// `y` place the pixel in its region, for the Dissolve pattern.
pub fn mix_pixel(mode: MixMode, d: [f32; 4], s: [f32; 4], x: u32, y: u32) -> [f32; 4] {
    use MixMode::*;
    match mode {
        Over => blend_with(d, s, |_, sc| sc),
        Under => under(d, s),
        Overwrite => s,
        Dissolve => {
            let kept = if s[3] > dissolve_threshold(x, y) {
                1.0
            } else {
                0.0
            };
            blend_with(d, [s[0], s[1], s[2], kept], |_, sc| sc)
        }
        DarkerColor | LighterColor | Hue | Saturation | Color | Luminosity => {
            blend_with(d, s, |dc, sc| non_separable(mode, dc, sc))
        }
        In | DestinationIn | Out | DestinationOut | Atop | DestinationAtop | Plus | MaskInvert
        | XorComposite => porter_duff(mode, d, s),
        Xor8 => blend_with(d, s, |dc, sc| {
            per_channel(dc, sc, |a, b| xor_channel(a, b, 255.0))
        }),
        Xor16 => blend_with(d, s, |dc, sc| {
            per_channel(dc, sc, |a, b| xor_channel(a, b, 65535.0))
        }),
        _ => blend_with(d, s, |dc, sc| {
            per_channel(dc, sc, |a, b| separable(mode, a, b))
        }),
    }
}

fn straight(px: &[u8; 4]) -> [f32; 4] {
    [
        f32::from(px[0]) / 255.0,
        f32::from(px[1]) / 255.0,
        f32::from(px[2]) / 255.0,
        f32::from(px[3]) / 255.0,
    ]
}

/// Composites the generated image `src` (straight RGBA on 0..=1, `width` pixels per row) onto `dst`
/// (straight RGBA8, the same pixels), returning straight RGBA8.
pub fn mix_rgba8(
    dst: &[u8],
    src: &[[f32; 4]],
    width: usize,
    mode: MixMode,
) -> Result<Vec<u8>, String> {
    if width == 0 || !src.len().is_multiple_of(width) {
        return Err(format!("{} pixels do not fill rows of {width}", src.len()));
    }
    if dst.len() != src.len() * 4 {
        return Err(format!(
            "destination must hold {} RGBA8 pixels, got {} bytes",
            src.len(),
            dst.len()
        ));
    }
    let mut out = Vec::with_capacity(dst.len());
    for (i, (d, s)) in dst.as_chunks::<4>().0.iter().zip(src).enumerate() {
        let px = mix_pixel(
            mode,
            straight(d),
            *s,
            (i % width) as u32,
            (i / width) as u32,
        );
        out.extend([to_u8(px[0]), to_u8(px[1]), to_u8(px[2]), to_u8(px[3])]);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::MixMode::*;
    use super::*;

    fn close(a: [f32; 4], b: [f32; 4]) {
        for c in 0..4 {
            assert!((a[c] - b[c]).abs() < 1e-5, "{a:?} != {b:?}");
        }
    }

    #[test]
    fn modes_are_the_spec_list_in_order() {
        assert_eq!(MixMode::ALL.len(), 46);
        for (i, mode) in MixMode::ALL.into_iter().enumerate() {
            assert_eq!(mode as usize, i);
            assert_eq!(MixMode::try_from(i as u8), Ok(mode));
        }
        assert_eq!(MixMode::try_from(46), Err(46));
        assert_eq!(MixMode::ALL[3], Multiply);
        assert_eq!(MixMode::ALL[28], Division);
        assert_eq!(MixMode::ALL[29], Additive);
        assert_eq!(MixMode::ALL[34], Max);
        assert_eq!(MixMode::ALL[35], In);
        assert_eq!(MixMode::ALL[43], Xor8);
        assert_eq!(MixMode::ALL[45], XorComposite);
    }

    #[test]
    fn separable_blends_match_hand_computed_values() {
        let d = 0.4;
        let s = 0.7;
        close(
            [separable(Multiply, d, s), 0.0, 0.0, 0.0],
            [0.28, 0.0, 0.0, 0.0],
        );
        close(
            [separable(Screen, d, s), 0.0, 0.0, 0.0],
            [0.82, 0.0, 0.0, 0.0],
        );
        close(
            [separable(Overlay, d, s), 0.0, 0.0, 0.0],
            [0.56, 0.0, 0.0, 0.0],
        );
        close(
            [separable(HardLight, d, s), 0.0, 0.0, 0.0],
            [0.64, 0.0, 0.0, 0.0],
        );
        close(
            [separable(LinearBurn, d, s), 0.0, 0.0, 0.0],
            [0.1, 0.0, 0.0, 0.0],
        );
        close(
            [separable(Exclusion, d, s), 0.0, 0.0, 0.0],
            [0.54, 0.0, 0.0, 0.0],
        );
        close(
            [separable(Subtract, s, d), 0.0, 0.0, 0.0],
            [0.3, 0.0, 0.0, 0.0],
        );
        close(
            [separable(Division, d, s), 0.0, 0.0, 0.0],
            [0.4 / 0.7, 0.0, 0.0, 0.0],
        );
        close(
            [separable(HardMix, d, s), 0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0, 0.0],
        );
        close(
            [separable(PinLight, 0.9, 0.2), 0.0, 0.0, 0.0],
            [0.4, 0.0, 0.0, 0.0],
        );
        close([separable(Min, d, s), 0.0, 0.0, 0.0], [0.4, 0.0, 0.0, 0.0]);
        close(
            [separable(Negation, d, s), 0.0, 0.0, 0.0],
            [0.9, 0.0, 0.0, 0.0],
        );
    }

    #[test]
    fn soft_light_follows_the_w3c_branches() {
        // Source at 0.25 darkens: 0.5 - (1 - 0.5)·0.5·0.5 = 0.375.
        assert!((separable(SoftLight, 0.5, 0.25) - 0.375).abs() < 1e-6);
        // Source at 0.75 lightens with D(0.25) = ((16·0.25 − 12)·0.25 + 4)·0.25 = 0.5.
        assert!((separable(SoftLight, 0.25, 0.75) - 0.375).abs() < 1e-6);
    }

    #[test]
    fn non_separable_modes_use_luminosity_and_saturation() {
        let d = [0.2, 0.4, 0.6];
        let s = [0.8, 0.1, 0.3];
        // Color keeps the source hue and saturation, and takes the destination luminosity.
        let color = non_separable(Color, d, s);
        assert!((lum(color) - lum(d)).abs() < 1e-5);
        // Luminosity keeps the destination's colors, and takes the source luminosity.
        let luminosity = non_separable(Luminosity, d, s);
        assert!((lum(luminosity) - lum(s)).abs() < 1e-5);
        assert_eq!(non_separable(DarkerColor, d, s), s);
        assert_eq!(non_separable(LighterColor, d, s), d);
        // A pure gray has no saturation, so Hue leaves the destination's gray at its luminosity.
        let gray = non_separable(Hue, [0.5; 3], [0.9, 0.1, 0.4]);
        assert!(sat(gray) < 1e-5);
    }

    #[test]
    fn over_and_overwrite_match_the_standard_composites() {
        // Opaque source over anything is the source.
        close(
            mix_pixel(Over, [0.2, 0.3, 0.4, 1.0], [0.9, 0.8, 0.7, 1.0], 0, 0),
            [0.9, 0.8, 0.7, 1.0],
        );
        // Half-transparent source over an opaque destination is the average.
        close(
            mix_pixel(Over, [0.0, 0.0, 0.0, 1.0], [1.0, 1.0, 1.0, 0.5], 0, 0),
            [0.5, 0.5, 0.5, 1.0],
        );
        // Under puts the destination on top: opaque destination ignores the source.
        close(
            mix_pixel(Under, [0.2, 0.3, 0.4, 1.0], [0.9, 0.8, 0.7, 1.0], 0, 0),
            [0.2, 0.3, 0.4, 1.0],
        );
        // Under fills a transparent destination with the source.
        close(
            mix_pixel(Under, [0.0; 4], [0.9, 0.8, 0.7, 0.5], 0, 0),
            [0.9, 0.8, 0.7, 0.5],
        );
        close(
            mix_pixel(Overwrite, [0.2, 0.3, 0.4, 1.0], [0.9, 0.8, 0.7, 0.25], 0, 0),
            [0.9, 0.8, 0.7, 0.25],
        );
    }

    #[test]
    fn porter_duff_modes_match_their_definitions() {
        let d = [0.2, 0.4, 0.6, 0.5];
        let s = [0.8, 0.6, 0.4, 0.25];
        // In keeps the source where the destination is: alpha sa·da, color s.
        close(porter_duff(In, d, s), [0.8, 0.6, 0.4, 0.125]);
        // Destination In keeps the destination where the source is.
        close(porter_duff(DestinationIn, d, s), [0.2, 0.4, 0.6, 0.125]);
        // Out and Destination Out are complementary.
        close(porter_duff(Out, d, s), [0.8, 0.6, 0.4, 0.125]);
        close(porter_duff(DestinationOut, d, s), [0.2, 0.4, 0.6, 0.375]);
        // Plus adds premultiplied colors (0.375 + 0.25) and alpha (0.75 + 0.5, clamped to 1).
        let plus = porter_duff(Plus, [0.5, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.75]);
        close(plus, [0.625, 0.625, 0.625, 1.0]);
        // Xor (Composite) keeps only the parts where exactly one of the two covers.
        close(porter_duff(XorComposite, [1.0; 4], [1.0; 4]), [0.0; 4]);
    }

    #[test]
    fn xor_modes_xor_the_quantized_channels() {
        // 0b1100_1010 ^ 0b1010_0110 = 0b0110_1100 = 108.
        let out = mix_pixel(
            Xor8,
            [202.0 / 255.0, 0.0, 1.0, 1.0],
            [166.0 / 255.0, 0.0, 1.0, 1.0],
            0,
            0,
        );
        assert!((out[0] * 255.0 - 108.0).abs() < 1e-3);
        assert!((out[2] - 0.0).abs() < 1e-6);
        // Sixteen-bit: 0x0F0F ^ 0xF0F0 = 0xFFFF, which is full scale.
        let sixteen = xor_channel(0x0F0F as f32 / 65535.0, 0xF0F0 as f32 / 65535.0, 65535.0);
        assert!((sixteen - 1.0).abs() < 1e-6);
    }

    #[test]
    fn dissolve_keeps_the_source_where_the_hash_is_below_its_alpha() {
        let mut kept = 0;
        for y in 0..64 {
            for x in 0..64 {
                let t = dissolve_threshold(x, y);
                assert!((0.0..1.0).contains(&t));
                if 0.5 > t {
                    kept += 1;
                }
            }
        }
        // A half-alpha source keeps about half the pixels.
        assert!((kept as f32 / 4096.0 - 0.5).abs() < 0.05, "kept {kept}");
        let out = mix_pixel(Dissolve, [0.0; 4], [1.0, 1.0, 1.0, 0.0], 3, 4);
        assert_eq!(out, [0.0; 4]);
    }

    #[test]
    fn mix_rgba8_checks_its_buffers() {
        let dst = [10u8, 20, 30, 255, 0, 0, 0, 0];
        let src = [[1.0, 1.0, 1.0, 1.0], [0.0; 4]];
        let out = mix_rgba8(&dst, &src, 2, Overwrite).expect("sizes match");
        assert_eq!(out, [255, 255, 255, 255, 0, 0, 0, 0]);
        assert!(mix_rgba8(&dst, &src, 3, Over).is_err());
        assert!(mix_rgba8(&dst[..4], &src, 2, Over).is_err());
    }
}
