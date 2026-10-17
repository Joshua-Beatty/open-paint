//! Reference layer compositing (DOC-BLD-01/02): straight-alpha RGBA8 "over" with layer
//! opacity and the 14 per-channel layer blend functions. These integer formulas are normative;
//! GPU compositing must match them within ±1 per channel.

/// Layer blend modes in their stored and UI order (DOC-BLD-01).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum BlendMode {
    Normal = 0,
    Multiply = 1,
    Additive = 2,
    ColorBurn = 3,
    ColorDodge = 4,
    Reflect = 5,
    Glow = 6,
    Overlay = 7,
    Difference = 8,
    Negation = 9,
    Lighten = 10,
    Darken = 11,
    Screen = 12,
    Xor = 13,
}

impl BlendMode {
    pub const ALL: [BlendMode; 14] = [
        BlendMode::Normal,
        BlendMode::Multiply,
        BlendMode::Additive,
        BlendMode::ColorBurn,
        BlendMode::ColorDodge,
        BlendMode::Reflect,
        BlendMode::Glow,
        BlendMode::Overlay,
        BlendMode::Difference,
        BlendMode::Negation,
        BlendMode::Lighten,
        BlendMode::Darken,
        BlendMode::Screen,
        BlendMode::Xor,
    ];
}

impl TryFrom<u8> for BlendMode {
    type Error = u8;

    fn try_from(value: u8) -> Result<Self, u8> {
        Self::ALL.get(usize::from(value)).copied().ok_or(value)
    }
}

/// `round(a * b / 255)` for 8-bit values; exact because a tie is impossible.
#[inline]
pub fn mul(a: u32, b: u32) -> u32 {
    (a * b + 127) / 255
}

/// Per-channel blend function `f(d, s)` of DOC-BLD-02, clamped to 0..=255.
#[inline]
pub fn blend_channel(mode: BlendMode, d: u32, s: u32) -> u32 {
    match mode {
        BlendMode::Normal => s,
        BlendMode::Multiply => mul(d, s),
        BlendMode::Additive => (d + s).min(255),
        BlendMode::ColorBurn => match s {
            0 => 0,
            _ => 255u32.saturating_sub((255 - d) * 255 / s),
        },
        BlendMode::ColorDodge => match s {
            255 => 255,
            _ => (d * 255 / (255 - s)).min(255),
        },
        BlendMode::Reflect => match s {
            255 => 255,
            _ => (d * d / (255 - s)).min(255),
        },
        BlendMode::Glow => blend_channel(BlendMode::Reflect, s, d),
        BlendMode::Overlay => {
            if d < 128 {
                mul(2 * d, s)
            } else {
                255 - mul(2 * (255 - d), 255 - s)
            }
        }
        BlendMode::Difference => d.abs_diff(s),
        BlendMode::Negation => 255 - 255u32.abs_diff(d + s),
        BlendMode::Lighten => d.max(s),
        BlendMode::Darken => d.min(s),
        BlendMode::Screen => s + d - mul(s, d),
        BlendMode::Xor => d ^ s,
    }
}

/// `ceil(2^32 / d)` for every divisor `d` in 1..=255 (index 0 unused).
const RECIPROCALS: [u64; 256] = {
    let mut table = [0u64; 256];
    let mut d = 1;
    while d < 256 {
        table[d] = (1u64 << 32).div_ceil(d as u64);
        d += 1;
    }
    table
};

/// `x / d` for `d` in 1..=255 and `x < 2^24`, by multiplying with `RECIPROCALS[d]`. Exact: the
/// reciprocal's error `e = m·d − 2^32` is below `d`, so `x·e < 2^32` and the floor never moves.
#[inline]
fn div_small(x: u32, d: u32) -> u32 {
    ((u64::from(x) * RECIPROCALS[d as usize]) >> 32) as u32
}

/// Composites source pixel `s` over destination pixel `d` (DOC-BLD-02 steps 1-6).
#[inline]
pub fn composite_pixel(d: [u8; 4], s: [u8; 4], mode: BlendMode, opacity: u8) -> [u8; 4] {
    composite_pixel_with(d, s, opacity, |dc, sc| blend_channel(mode, dc, sc))
}

/// `composite_pixel` with the blend function `f` given directly, so a loop over one mode compiles
/// without the per-channel mode dispatch.
#[inline(always)]
fn composite_pixel_with(
    d: [u8; 4],
    s: [u8; 4],
    opacity: u8,
    f: impl Fn(u32, u32) -> u32,
) -> [u8; 4] {
    let sa = match opacity {
        0 => return d,
        255 => u32::from(s[3]),
        o => mul(u32::from(s[3]), u32::from(o)),
    };
    if sa == 0 {
        return d;
    }
    let da = u32::from(d[3]);
    if da == 0 {
        // Y = J = 0 and Ra = K = Sa', so each channel is (Sc·Sa' + Sa'/2) / Sa' = Sc.
        return [s[0], s[1], s[2], sa as u8];
    }
    let y = mul(da, 255 - sa);
    // Ra >= Sa' > 0, so the spec's transparent Ra = 0 case cannot occur past the check above.
    let ra = y + sa;
    let j = mul(da, sa);
    let k = sa - j;
    let mut out = [0, 0, 0, ra as u8];
    for c in 0..3 {
        let (dc, sc) = (u32::from(d[c]), u32::from(s[c]));
        // Normal reduces to (Dc·Y + Sc·Sa') / Ra since f = s and K + J = Sa'.
        let n = dc * y + sc * k + f(dc, sc) * j;
        out[c] = div_small(n + ra / 2, ra) as u8;
    }
    out
}

fn composite_mode(
    dst: &mut [[u8; 4]],
    src: &[[u8; 4]],
    opacity: u8,
    f: impl Fn(u32, u32) -> u32 + Copy,
) {
    for (d, s) in dst.iter_mut().zip(src) {
        *d = composite_pixel_with(*d, *s, opacity, f);
    }
}

/// Composites a straight-alpha RGBA8 source buffer over a destination buffer of the same size in
/// place, pixel by pixel.
///
/// # Panics
/// If the buffers differ in length or the length is not a multiple of 4.
pub fn composite(dst: &mut [u8], src: &[u8], mode: BlendMode, opacity: u8) {
    assert_eq!(dst.len(), src.len(), "source and destination sizes differ");
    assert!(
        dst.len().is_multiple_of(4),
        "buffer length is not a multiple of 4"
    );
    if opacity == 0 {
        return;
    }
    let (dst, _) = dst.as_chunks_mut::<4>();
    let (src, _) = src.as_chunks::<4>();
    // One loop per mode, so the blend function is inlined without a per-channel dispatch.
    macro_rules! each_mode {
        ($($mode:ident),*) => {
            match mode {
                $(BlendMode::$mode => composite_mode(dst, src, opacity, |d, s| {
                    blend_channel(BlendMode::$mode, d, s)
                }),)*
            }
        };
    }
    each_mode!(
        Normal, Multiply, Additive, ColorBurn, ColorDodge, Reflect, Glow, Overlay, Difference,
        Negation, Lighten, Darken, Screen, Xor
    );
}

#[cfg(test)]
mod tests {
    use super::BlendMode::*;
    use super::*;

    #[test]
    fn modes_round_trip_through_their_stored_values() {
        for (i, mode) in BlendMode::ALL.into_iter().enumerate() {
            assert_eq!(mode as usize, i);
            assert_eq!(BlendMode::try_from(i as u8), Ok(mode));
        }
        assert_eq!(BlendMode::try_from(14), Err(14));
        assert_eq!(BlendMode::try_from(255), Err(255));
    }

    #[test]
    fn mul_rounds_to_nearest_for_every_pair() {
        for a in 0..=255u32 {
            for b in 0..=255u32 {
                assert_eq!(
                    mul(a, b),
                    (f64::from(a * b) / 255.0).round() as u32,
                    "{a}·{b}"
                );
            }
        }
    }

    /// Hand-computed f(d, s) values from the DOC-BLD-02 table.
    #[test]
    fn blend_functions_match_hand_computed_values() {
        let cases: &[(BlendMode, u32, u32, u32)] = &[
            (Normal, 200, 100, 100),
            (Normal, 0, 255, 255),
            // round(20000/255 = 78.43), round(16384/255 = 64.25)
            (Multiply, 200, 100, 78),
            (Multiply, 128, 128, 64),
            (Multiply, 255, 255, 255),
            (Multiply, 0, 255, 0),
            (Additive, 100, 50, 150),
            (Additive, 200, 100, 255),
            // 255 − ⌊55·255/100 = 140.25⌋
            (ColorBurn, 200, 100, 115),
            (ColorBurn, 100, 50, 0),
            (ColorBurn, 255, 1, 255),
            (ColorBurn, 0, 255, 0),
            (ColorBurn, 255, 0, 0),
            // ⌊100·255/155 = 164.5⌋
            (ColorDodge, 100, 100, 164),
            (ColorDodge, 200, 100, 255),
            (ColorDodge, 0, 254, 0),
            (ColorDodge, 0, 255, 255),
            // ⌊10000/155 = 64.5⌋, ⌊256/255⌋
            (Reflect, 100, 100, 64),
            (Reflect, 16, 0, 1),
            (Reflect, 200, 200, 255),
            (Reflect, 0, 255, 255),
            // ⌊20²/205 = 1.95⌋, ⌊50²/235 = 10.6⌋
            (Glow, 50, 20, 1),
            (Glow, 20, 50, 10),
            (Glow, 100, 100, 64),
            (Glow, 255, 0, 255),
            (Glow, 0, 16, 1),
            // mul(200, 200) = round(156.86); 255 − mul(110, 155) = 255 − round(66.86)
            (Overlay, 100, 200, 157),
            (Overlay, 200, 100, 188),
            (Overlay, 127, 255, 254),
            (Overlay, 128, 0, 1),
            (Overlay, 0, 255, 0),
            (Overlay, 255, 0, 255),
            (Difference, 100, 30, 70),
            (Difference, 30, 100, 70),
            (Difference, 0, 255, 255),
            // 255 − |255 − 130|, 255 − |255 − 300|
            (Negation, 100, 30, 130),
            (Negation, 200, 100, 210),
            (Negation, 0, 0, 0),
            (Negation, 255, 0, 255),
            (Negation, 255, 255, 0),
            (Lighten, 100, 30, 100),
            (Lighten, 30, 100, 100),
            (Darken, 100, 30, 30),
            (Darken, 30, 100, 30),
            // 300 − mul(200, 100)
            (Screen, 100, 200, 222),
            (Screen, 255, 17, 255),
            (Screen, 0, 0, 0),
            // 0b1100_1010 ^ 0b1010_0110 = 0b0110_1100
            (Xor, 202, 166, 108),
            (Xor, 255, 255, 0),
            (Xor, 255, 0, 255),
        ];
        for &(mode, d, s, expected) in cases {
            assert_eq!(blend_channel(mode, d, s), expected, "{mode:?} f({d}, {s})");
        }
    }

    /// The DOC-BLD-02 table transcribed literally with signed, unclamped intermediates.
    fn spec_f(mode: BlendMode, d: i64, s: i64) -> i64 {
        let m = |a: i64, b: i64| (a as f64 * b as f64 / 255.0).round() as i64;
        let v = match mode {
            Normal => s,
            Multiply => m(d, s),
            Additive => 255.min(d + s),
            ColorBurn if s == 0 => 0,
            ColorBurn => 0.max(255 - (255 - d) * 255 / s),
            ColorDodge if s == 255 => 255,
            ColorDodge => 255.min(d * 255 / (255 - s)),
            Reflect if s == 255 => 255,
            Reflect => 255.min(d * d / (255 - s)),
            Glow if d == 255 => 255,
            Glow => 255.min(s * s / (255 - d)),
            Overlay if d < 128 => m(2 * d, s),
            Overlay => 255 - m(2 * (255 - d), 255 - s),
            Difference => (s - d).abs(),
            Negation => 255 - (255 - d - s).abs(),
            Lighten => d.max(s),
            Darken => d.min(s),
            Screen => s + d - m(s, d),
            Xor => d ^ s,
        };
        v.clamp(0, 255)
    }

    #[test]
    fn blend_functions_match_the_spec_table_for_every_pair() {
        for mode in BlendMode::ALL {
            for d in 0..=255u32 {
                for s in 0..=255u32 {
                    let expected = spec_f(mode, i64::from(d), i64::from(s));
                    assert_eq!(
                        i64::from(blend_channel(mode, d, s)),
                        expected,
                        "{mode:?} f({d}, {s})"
                    );
                }
            }
        }
    }

    /// DOC-BLD-02 steps 1-6 with exact rational arithmetic and round-half-up division.
    fn spec_composite(d: [u8; 4], s: [u8; 4], mode: BlendMode, o: u8) -> [u8; 4] {
        let m = |a: i64, b: i64| (a as f64 * b as f64 / 255.0).round() as i64;
        let sa = m(i64::from(s[3]), i64::from(o));
        if o == 0 || sa == 0 {
            return d;
        }
        let da = i64::from(d[3]);
        let y = m(da, 255 - sa);
        let ra = y + sa;
        if ra == 0 {
            return [0; 4];
        }
        let j = m(da, sa);
        let k = sa - j;
        let mut out = [0, 0, 0, ra as u8];
        for c in 0..3 {
            let (dc, sc) = (i64::from(d[c]), i64::from(s[c]));
            let n = if mode == Normal {
                dc * y + sc * sa
            } else {
                dc * y + sc * k + spec_f(mode, dc, sc) * j
            };
            out[c] = (n as f64 / ra as f64 + 0.5).floor() as u8;
        }
        out
    }

    #[test]
    fn normal_matches_hand_computed_over() {
        // Sa' = 128, Y = mul(255, 127) = 127, Ra = 255:
        // R = 200·127/255 = 99.6, G = (100·127 + 100·128)/255 = 100, B = (50·127 + 200·128)/255 = 125.3
        assert_eq!(
            composite_pixel([200, 100, 50, 255], [0, 100, 200, 128], Normal, 255),
            [100, 100, 125, 255]
        );
        // Opacity 128 scales Sa to mul(255, 128) = 128; over transparent the color is S unchanged.
        assert_eq!(
            composite_pixel([0, 0, 0, 0], [255, 7, 0, 255], Normal, 128),
            [255, 7, 0, 128]
        );
        // Opaque source replaces the destination.
        assert_eq!(
            composite_pixel([9, 8, 7, 255], [1, 2, 3, 255], Normal, 255),
            [1, 2, 3, 255]
        );
        // Sa' = 64, Da = 128: Y = mul(128, 191) = 96, Ra = 160; R = (255·96 + 0·64)/160 = 153
        assert_eq!(
            composite_pixel([255, 0, 40, 128], [0, 255, 40, 64], Normal, 255),
            [153, 102, 40, 160]
        );
    }

    #[test]
    fn blend_modes_match_hand_computed_composites() {
        // Multiply: Sa' = 200, Da = 128 → Y = mul(128, 55) = 28, Ra = 228, J = mul(128, 200) = 100, K = 100;
        // B = (78, 78, 0); R = (200·28 + 100·100 + 78·100)/228 = 102.6, G = 30600/228 = 134.2, B = 1400/228 = 6.1
        assert_eq!(
            composite_pixel([200, 100, 50, 128], [100, 200, 0, 200], Multiply, 255),
            [103, 134, 6, 228]
        );
        // Screen at opacity 128 over opaque: Sa' = 128, Y = 127, Ra = 255, J = 128, K = 0;
        // B = 222, R = (100·127 + 222·128)/255 = 161.2
        assert_eq!(
            composite_pixel([100, 100, 100, 255], [200, 200, 200, 255], Screen, 128),
            [161, 161, 161, 255]
        );
        // Difference over a transparent destination shows the source unchanged (J = 0).
        assert_eq!(
            composite_pixel([10, 20, 30, 0], [200, 100, 50, 77], Difference, 255),
            [200, 100, 50, 77]
        );
        // Opaque over opaque yields exactly f(d, s): Xor and Color Burn.
        assert_eq!(
            composite_pixel([202, 0, 255, 255], [166, 0, 255, 255], Xor, 255),
            [108, 0, 0, 255]
        );
        assert_eq!(
            composite_pixel([200, 100, 255, 255], [100, 50, 1, 255], ColorBurn, 255),
            [115, 0, 255, 255]
        );
    }

    #[test]
    fn skips_zero_opacity_and_fully_transparent_sources() {
        let d = [12, 34, 56, 78];
        for mode in BlendMode::ALL {
            assert_eq!(composite_pixel(d, [255, 255, 255, 255], mode, 0), d);
            assert_eq!(composite_pixel(d, [255, 255, 255, 0], mode, 255), d);
            // mul(1, 127) = 0: opacity can scale a faint source to nothing.
            assert_eq!(composite_pixel(d, [255, 255, 255, 1], mode, 127), d);
        }
    }

    #[test]
    fn every_alpha_pair_matches_the_spec_steps() {
        let colors = [
            ([0, 128, 255], [255, 127, 0]),
            ([200, 100, 50], [30, 150, 250]),
        ];
        for mode in BlendMode::ALL {
            for (dc, sc) in colors {
                for da in 0..=255u8 {
                    for sa in 0..=255u8 {
                        let d = [dc[0], dc[1], dc[2], da];
                        let s = [sc[0], sc[1], sc[2], sa];
                        for o in [255, 128] {
                            assert_eq!(
                                composite_pixel(d, s, mode, o),
                                spec_composite(d, s, mode, o),
                                "{mode:?} D={d:?} S={s:?} O={o}"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn every_color_pair_matches_the_spec_steps_at_partial_alpha() {
        for mode in BlendMode::ALL {
            for dc in 0..=255u8 {
                for sc in 0..=255u8 {
                    let d = [dc, sc, dc, 180];
                    let s = [sc, dc, 255 - sc, 90];
                    assert_eq!(
                        composite_pixel(d, s, mode, 200),
                        spec_composite(d, s, mode, 200)
                    );
                }
            }
        }
    }

    #[test]
    fn composites_whole_buffers_in_place() {
        let mut dst = [200, 100, 50, 255, 0, 0, 0, 0, 12, 34, 56, 78];
        let src = [0, 100, 200, 128, 255, 7, 0, 255, 255, 255, 255, 0];
        composite(&mut dst, &src, Normal, 255);
        assert_eq!(dst, [100, 100, 125, 255, 255, 7, 0, 255, 12, 34, 56, 78]);

        let before = dst;
        composite(&mut dst, &src, Multiply, 0);
        assert_eq!(dst, before);
    }

    #[test]
    fn reciprocal_division_is_exact_for_every_composite_numerator() {
        for d in 1..=255u32 {
            for x in 0..=(255 * 255 + 255) {
                assert_eq!(div_small(x, d), x / d, "{x} / {d}");
            }
        }
    }

    #[test]
    fn buffer_loops_match_the_pixel_formula_in_every_mode() {
        let mut state = 0x2545_f491_u32;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state & 0xff) as u8
        };
        let src: Vec<u8> = (0..4 * 4096).map(|_| next()).collect();
        let mut base: Vec<u8> = (0..4 * 4096).map(|_| next()).collect();
        // Some transparent and opaque destinations and sources.
        for i in (3..base.len()).step_by(20) {
            base[i] = 0;
        }
        for i in (7..base.len()).step_by(28) {
            base[i] = 255;
        }
        for mode in BlendMode::ALL {
            for opacity in [255, 200, 1] {
                let mut dst = base.clone();
                composite(&mut dst, &src, mode, opacity);
                for p in 0..4096 {
                    let at = |b: &[u8]| [b[4 * p], b[4 * p + 1], b[4 * p + 2], b[4 * p + 3]];
                    let d = at(&base);
                    let s = at(&src);
                    assert_eq!(
                        at(&dst),
                        spec_composite(d, s, mode, opacity),
                        "{mode:?} D={d:?} S={s:?} O={opacity}"
                    );
                }
            }
        }
    }

    #[test]
    #[should_panic(expected = "sizes differ")]
    fn rejects_mismatched_buffers() {
        composite(&mut [0; 8], &[0; 4], Normal, 255);
    }

    #[test]
    #[should_panic(expected = "multiple of 4")]
    fn rejects_partial_pixels() {
        composite(&mut [0; 6], &[0; 6], Normal, 255);
    }
}
