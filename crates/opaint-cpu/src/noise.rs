//! Add Noise and Reduce Noise (FX-NOISE-ADD, FX-NOISE-REDUCE). Add Noise draws its deviates from a
//! table built here and passed to the WGSL twin as a storage buffer, so both backends read the same
//! numbers. `packages/effects/src/add-noise-wgsl.ts` and `reduce-noise-wgsl.ts` are the WGSL twins.

use crate::blur::mirror_index;
use crate::neighborhood_blur::disc;
use crate::rng::PixelRng;

/// Entries in the Add Noise deviate table (FX-NOISE-ADD-03).
pub const ADD_NOISE_TABLE_SIZE: usize = 16384;
/// Deviate units per standard deviation. Intensity 64 gives `dev = 1024`, so the output standard
/// deviation is `1024 * 65536 / 24 / 65536` levels, about 42.7, which is 1/6 of full scale. This is the
/// tuning the spec asks for. The proposed `65536 / 4` would give 256 levels at Intensity 64.
pub const ADD_NOISE_TABLE_SCALE: f64 = 65536.0 / 24.0;
/// The largest Add Noise Intensity (FX-NOISE-ADD-02).
pub const ADD_NOISE_MAX_INTENSITY: u32 = 100;
/// The largest Add Noise Color Saturation (FX-NOISE-ADD-02).
pub const ADD_NOISE_MAX_SATURATION: u32 = 400;
/// The largest Reduce Noise radius (FX-NOISE-REDUCE-02).
pub const REDUCE_NOISE_MAX_RADIUS: u32 = 50;

/// The inverse of the standard normal cumulative curve, Φ⁻¹(p) for `0 < p < 1`. Peter Acklam's rational
/// approximation, with a relative error below 1.2e-9.
pub fn normal_quantile(p: f64) -> f64 {
    const A: [f64; 6] = [
        -3.969_683_028_665_376e1,
        2.209_460_984_245_205e2,
        -2.759_285_104_469_687e2,
        1.383_577_518_672_69e2,
        -3.066_479_806_614_716e1,
        2.506_628_277_459_239,
    ];
    const B: [f64; 5] = [
        -5.447_609_879_822_406e1,
        1.615_858_368_580_409e2,
        -1.556_989_798_598_866e2,
        6.680_131_188_771_972e1,
        -1.328_068_155_288_572e1,
    ];
    const C: [f64; 6] = [
        -7.784_894_002_430_293e-3,
        -3.223_964_580_411_365e-1,
        -2.400_758_277_161_838,
        -2.549_732_539_343_734,
        4.374_664_141_464_968,
        2.938_163_982_698_783,
    ];
    const D: [f64; 4] = [
        7.784_695_709_041_462e-3,
        3.224_671_290_700_398e-1,
        2.445_134_137_142_996,
        3.754_408_661_907_416,
    ];
    const P_LOW: f64 = 0.024_25;

    if p < P_LOW {
        let q = (-2.0 * p.ln()).sqrt();
        (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5])
            / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1.0)
    } else if p <= 1.0 - P_LOW {
        let q = p - 0.5;
        let r = q * q;
        (((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q
            / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1.0)
    } else {
        let q = (-2.0 * (1.0 - p).ln()).sqrt();
        -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5])
            / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1.0)
    }
}

/// The Add Noise deviate table (FX-NOISE-ADD-03): entry `k` is `round(Φ⁻¹((k + 0.5) / 16384) * SCALE)`,
/// so the entries are the equal-probability slots of a normal distribution, centered on 0.
pub fn add_noise_table() -> Vec<i32> {
    (0..ADD_NOISE_TABLE_SIZE)
        .map(|k| {
            let p = (k as f64 + 0.5) / ADD_NOISE_TABLE_SIZE as f64;
            (normal_quantile(p) * ADD_NOISE_TABLE_SCALE).round() as i32
        })
        .collect()
}

/// Add Noise of a straight-alpha RGBA8 image (FX-NOISE-ADD-03). Each pixel draws `u`, and it is left
/// unchanged when `u > coverage / 100`. Otherwise three table indices give the deviates `r1, g1, b1`.
/// Their luma-weighted mean `i` is blended with each deviate by `saturation`, and the channel changes by
/// `(c2 * dev + 32768) >> 16`, with `dev = intensity² / 4`. The alpha is unchanged.
///
/// The seed is the effective seed `userSeed XOR instanceSeed`. The pixel's draws come from `PixelRng`, so
/// `packages/effects/src/add-noise-wgsl.ts` reads the same numbers.
pub fn add_noise_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    intensity: u32,
    saturation: u32,
    coverage: f32,
    seed: u32,
) -> Result<Vec<u8>, String> {
    if src.len() != width * height * 4 {
        return Err(format!("source must be {width}x{height} RGBA8"));
    }
    if intensity > ADD_NOISE_MAX_INTENSITY {
        return Err(format!(
            "add noise intensity must be 0-{ADD_NOISE_MAX_INTENSITY}, got {intensity}"
        ));
    }
    if saturation > ADD_NOISE_MAX_SATURATION {
        return Err(format!(
            "add noise color saturation must be 0-{ADD_NOISE_MAX_SATURATION}, got {saturation}"
        ));
    }
    if !(coverage.is_finite() && (0.0..=100.0).contains(&coverage)) {
        return Err(format!("add noise coverage must be 0-100, got {coverage}"));
    }
    let table = add_noise_table();
    let dev = (intensity * intensity / 4) as i32;
    let sat = ((saturation * 4096 + 50) / 100) as i32;
    let mut out = Vec::with_capacity(src.len());
    for y in 0..height {
        for x in 0..width {
            let base = (y * width + x) * 4;
            let mut rng = PixelRng::new(seed, x as u32, y as u32);
            if rng.next_unit() > coverage / 100.0 {
                out.extend_from_slice(&src[base..base + 4]);
                continue;
            }
            let r1 = deviate(&table, rng.next_unit());
            let g1 = deviate(&table, rng.next_unit());
            let b1 = deviate(&table, rng.next_unit());
            let i = (4899 * r1 + 9618 * g1 + 1867 * b1) >> 14;
            out.push(add_channel(src[base], r1, i, sat, dev));
            out.push(add_channel(src[base + 1], g1, i, sat, dev));
            out.push(add_channel(src[base + 2], b1, i, sat, dev));
            out.push(src[base + 3]);
        }
    }
    Ok(out)
}

/// The table entry for a draw in `[0, 1)`.
fn deviate(table: &[i32], unit: f32) -> i32 {
    let index = ((unit * ADD_NOISE_TABLE_SIZE as f32) as usize).min(ADD_NOISE_TABLE_SIZE - 1);
    table[index]
}

/// One channel of Add Noise: the saturation blend `c2` and the clamped result (FX-NOISE-ADD-03).
fn add_channel(value: u8, c1: i32, i: i32, sat: i32, dev: i32) -> u8 {
    let c2 = i + (((c1 - i) * sat) >> 12);
    let delta = (c2 * dev + 32768) >> 16;
    (i32::from(value) + delta).clamp(0, 255) as u8
}

/// Reduce Noise of a straight-alpha RGBA8 image (FX-NOISE-REDUCE-03). Each color channel becomes
/// `v + (rank - v) * λ`, where `rank` is the share of the disc's pixels strictly darker than the pixel in
/// that channel, and `λ = -0.2 * strength * (1 - 0.75 Y)` with the pixel's luma `Y` on the 0-1 scale.
/// The edges are mirrored. A radius of 0 passes the image through. The alpha is unchanged.
pub fn reduce_noise_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    radius: u32,
    strength: f32,
) -> Result<Vec<u8>, String> {
    if src.len() != width * height * 4 {
        return Err(format!("source must be {width}x{height} RGBA8"));
    }
    if radius > REDUCE_NOISE_MAX_RADIUS {
        return Err(format!(
            "reduce noise radius must be 0-{REDUCE_NOISE_MAX_RADIUS}, got {radius}"
        ));
    }
    if !(strength.is_finite() && (0.0..=1.0).contains(&strength)) {
        return Err(format!("reduce noise strength must be 0-1, got {strength}"));
    }
    if radius == 0 {
        return Ok(src.to_vec());
    }
    let offsets = disc(radius);
    let count = offsets.len() as f32;
    let factor = -0.2 * strength;
    let mut out = Vec::with_capacity(src.len());
    for y in 0..height {
        for x in 0..width {
            let base = (y * width + x) * 4;
            let center = [src[base], src[base + 1], src[base + 2]];
            let v = center.map(|c| f32::from(c) / 255.0);
            let luma = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
            let lambda = factor * (1.0 - 0.75 * luma);
            let mut below = [0u32; 3];
            for &(dx, dy) in &offsets {
                let nx = mirror_index(x as isize + dx, width);
                let ny = mirror_index(y as isize + dy, height);
                let n = (ny * width + nx) * 4;
                for (channel, count_below) in below.iter_mut().enumerate() {
                    if src[n + channel] < center[channel] {
                        *count_below += 1;
                    }
                }
            }
            for channel in 0..3 {
                let rank = below[channel] as f32 / count;
                let mixed = (v[channel] + (rank - v[channel]) * lambda).clamp(0.0, 1.0);
                out.push((mixed * 255.0 + 0.5).floor() as u8);
            }
            out.push(src[base + 3]);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_quantile_matches_known_points() {
        assert!(normal_quantile(0.5).abs() < 1e-12);
        assert!((normal_quantile(0.975) - 1.959_963_985).abs() < 1e-6);
        assert!((normal_quantile(0.025) + 1.959_963_985).abs() < 1e-6);
        assert!((normal_quantile(0.000_01) + 4.264_890_794).abs() < 1e-5);
    }

    #[test]
    fn table_is_sorted_symmetric_and_has_the_tuned_spread() {
        let table = add_noise_table();
        assert_eq!(table.len(), ADD_NOISE_TABLE_SIZE);
        assert!(table.windows(2).all(|pair| pair[0] <= pair[1]));
        for k in 0..ADD_NOISE_TABLE_SIZE {
            assert_eq!(table[k], -table[ADD_NOISE_TABLE_SIZE - 1 - k]);
        }
        let mean_square: f64 = table
            .iter()
            .map(|&value| f64::from(value) * f64::from(value))
            .sum::<f64>()
            / ADD_NOISE_TABLE_SIZE as f64;
        let sigma = mean_square.sqrt() / ADD_NOISE_TABLE_SCALE;
        assert!((sigma - 1.0).abs() < 0.01, "sigma {sigma}");
        let at_intensity_64 = mean_square.sqrt() * 1024.0 / 65536.0;
        assert!((at_intensity_64 - 255.0 / 6.0).abs() < 1.0, "{at_intensity_64}");
    }

    fn gray(width: usize, height: usize, value: u8) -> Vec<u8> {
        std::iter::repeat_n([value, value, value, 255], width * height)
            .flatten()
            .collect()
    }

    #[test]
    fn zero_coverage_and_zero_intensity_leave_the_image_unchanged() {
        let src = gray(6, 5, 90);
        assert_eq!(add_noise_rgba8(&src, 6, 5, 64, 100, 0.0, 3).unwrap(), src);
        assert_eq!(add_noise_rgba8(&src, 6, 5, 0, 100, 100.0, 3).unwrap(), src);
    }

    #[test]
    fn add_noise_keeps_alpha_and_is_seed_dependent() {
        let mut src = gray(16, 16, 128);
        for pixel in src.as_chunks_mut::<4>().0.iter_mut() {
            pixel[3] = 77;
        }
        let a = add_noise_rgba8(&src, 16, 16, 64, 100, 100.0, 1).unwrap();
        assert!(a.as_chunks::<4>().0.iter().all(|px| px[3] == 77));
        assert_eq!(a, add_noise_rgba8(&src, 16, 16, 64, 100, 100.0, 1).unwrap());
        assert_ne!(a, add_noise_rgba8(&src, 16, 16, 64, 100, 100.0, 2).unwrap());
        assert!(a.as_chunks::<4>().0.iter().any(|px| px[0] != 128));
    }

    #[test]
    fn zero_saturation_gives_gray_noise() {
        let src = gray(16, 16, 128);
        let out = add_noise_rgba8(&src, 16, 16, 100, 0, 100.0, 9).unwrap();
        for pixel in out.as_chunks::<4>().0.iter() {
            assert_eq!(pixel[0], pixel[1]);
            assert_eq!(pixel[1], pixel[2]);
        }
    }

    #[test]
    fn add_noise_spread_is_about_one_sixth_of_full_scale() {
        let src = gray(64, 64, 128);
        let out = add_noise_rgba8(&src, 64, 64, 64, 100, 100.0, 5).unwrap();
        let deltas: Vec<f64> = out
            .as_chunks::<4>()
            .0
            .iter()
            .map(|px| f64::from(px[0]) - 128.0)
            .collect();
        let mean = deltas.iter().sum::<f64>() / deltas.len() as f64;
        let sigma = (deltas.iter().map(|d| (d - mean).powi(2)).sum::<f64>() / deltas.len() as f64)
            .sqrt();
        assert!((sigma - 255.0 / 6.0).abs() < 8.0, "sigma {sigma}");
    }

    #[test]
    fn reduce_noise_radius_zero_passes_through() {
        let src: Vec<u8> = (0..(5 * 4 * 4)).map(|i| (i * 7) as u8).collect();
        assert_eq!(reduce_noise_rgba8(&src, 5, 4, 0, 0.4).unwrap(), src);
    }

    #[test]
    fn reduce_noise_zero_strength_is_identity() {
        let src: Vec<u8> = (0..(7 * 6 * 4)).map(|i| (i * 13) as u8).collect();
        assert_eq!(reduce_noise_rgba8(&src, 7, 6, 3, 0.0).unwrap(), src);
    }

    #[test]
    fn reduce_noise_moves_a_dark_speck_and_keeps_alpha() {
        let mut src = gray(9, 9, 200);
        for pixel in src.as_chunks_mut::<4>().0.iter_mut() {
            pixel[3] = 33;
        }
        let center = (4 * 9 + 4) * 4;
        src[center..center + 3].copy_from_slice(&[40, 40, 40]);
        let out = reduce_noise_rgba8(&src, 9, 9, 2, 1.0).unwrap();
        assert!(out.as_chunks::<4>().0.iter().all(|px| px[3] == 33));
        assert!(out[center] > 40, "the speck moves away from its rank, toward the field");
    }

    #[test]
    fn invalid_settings_are_rejected() {
        let src = gray(2, 2, 0);
        assert!(add_noise_rgba8(&src, 2, 2, 101, 100, 100.0, 0).is_err());
        assert!(add_noise_rgba8(&src, 2, 2, 1, 401, 100.0, 0).is_err());
        assert!(add_noise_rgba8(&src, 2, 2, 1, 100, 101.0, 0).is_err());
        assert!(add_noise_rgba8(&src, 3, 2, 1, 100, 100.0, 0).is_err());
        assert!(reduce_noise_rgba8(&src, 2, 2, 51, 0.5).is_err());
        assert!(reduce_noise_rgba8(&src, 2, 2, 1, 1.5).is_err());
    }

    #[test]
    fn pixel_draws_do_not_depend_on_the_rest_of_the_image() {
        let small = gray(4, 4, 100);
        let big = gray(8, 8, 100);
        let a = add_noise_rgba8(&small, 4, 4, 50, 120, 60.0, 77).unwrap();
        let b = add_noise_rgba8(&big, 8, 8, 50, 120, 60.0, 77).unwrap();
        for y in 0..4 {
            for x in 0..4 {
                let small_at = (y * 4 + x) * 4;
                let big_at = (y * 8 + x) * 4;
                assert_eq!(a[small_at..small_at + 4], b[big_at..big_at + 4]);
            }
        }
    }
}
