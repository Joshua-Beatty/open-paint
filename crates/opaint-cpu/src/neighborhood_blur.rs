//! Median Blur and Surface Blur (FX-BLUR-MEDIAN, FX-BLUR-SURFACE). Both read the circular
//! neighborhood of each pixel. `packages/effects/src/median-blur-wgsl.ts` and `surface-blur-wgsl.ts`
//! are the WGSL twins. They read the same radius, percentile and slope, and the GPU runs them in
//! tiles, so no single dispatch runs long (FX-BLUR-MEDIAN-03).

use crate::blur::mirror_index;

/// The largest Median Blur radius (FX-BLUR-MEDIAN-02).
pub const MEDIAN_MAX_RADIUS: u32 = 100;
/// The Median Blur Quality range, in bits of precision (FX-BLUR-MEDIAN-02).
pub const MEDIAN_MAX_QUALITY: u32 = 9;
/// The largest Surface Blur radius (FX-BLUR-SURFACE-02).
pub const SURFACE_MAX_RADIUS: u32 = 50;

/// The offsets of the circular neighborhood of `radius`: every `(dx, dy)` with `dx² + dy² ≤ radius²`.
/// The center is always included.
pub(crate) fn disc(radius: u32) -> Vec<(isize, isize)> {
    let r = radius as isize;
    let mut offsets = Vec::new();
    for dy in -r..=r {
        for dx in -r..=r {
            if dx * dx + dy * dy <= r * r {
                offsets.push((dx, dy));
            }
        }
    }
    offsets
}

/// The percentile of one channel of a neighborhood (FX-BLUR-MEDIAN-03), at a whole percentage.
pub fn median_estimate(values: &[u8], percentile: u32, quality: u32) -> u8 {
    rank_estimate(values, percentile * 2, quality)
}

/// The rank of one channel of a neighborhood, in half-percent units (0-200, where 100 is the median),
/// so Outline's `(100 ± Intensity) / 2` percentiles are whole numbers. The search starts from the
/// neighborhood's own min and max. Each of the `quality` steps tests the midpoint and keeps the half
/// that holds the target rank `percentile2 / 200 * count`. The rank is compared as integers,
/// `below * 200 < percentile2 * count`, so both backends make the same choice. With 8 or more steps
/// the search is finer than one level, so the floor of the upper bound is the exact percentile of
/// 8-bit values.
pub fn rank_estimate(values: &[u8], percentile2: u32, quality: u32) -> u8 {
    let count = values.len() as u32;
    let mut lo = f32::from(values.iter().copied().min().unwrap_or(0));
    let mut hi = f32::from(values.iter().copied().max().unwrap_or(0));
    for _ in 0..quality {
        let mid = (lo + hi) * 0.5;
        let below = values.iter().filter(|&&v| f32::from(v) < mid).count() as u32;
        if below * 200 < percentile2 * count {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    hi.floor() as u8
}

/// Median Blur of a straight-alpha RGBA8 image (FX-BLUR-MEDIAN-03). Each channel, alpha included, is
/// the percentile of its values in the disc of `radius` around the pixel. Samples outside the image
/// take the clamped border. A radius of 0 passes the image through.
pub fn median_blur_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    radius: u32,
    percentile: u32,
    quality: u32,
) -> Result<Vec<u8>, String> {
    if src.len() != width * height * 4 {
        return Err(format!("source must be {width}x{height} RGBA8"));
    }
    if radius > MEDIAN_MAX_RADIUS {
        return Err(format!(
            "median radius must be 0-{MEDIAN_MAX_RADIUS}, got {radius}"
        ));
    }
    if percentile > 100 {
        return Err(format!("median percentile must be 0-100, got {percentile}"));
    }
    if !(1..=MEDIAN_MAX_QUALITY).contains(&quality) {
        return Err(format!(
            "median quality must be 1-{MEDIAN_MAX_QUALITY}, got {quality}"
        ));
    }
    let offsets = disc(radius);
    let mut out = Vec::with_capacity(src.len());
    let mut values = Vec::with_capacity(offsets.len());
    for y in 0..height {
        for x in 0..width {
            for channel in 0..4 {
                values.clear();
                for &(dx, dy) in &offsets {
                    let nx = (x as isize + dx).clamp(0, width as isize - 1) as usize;
                    let ny = (y as isize + dy).clamp(0, height as isize - 1) as usize;
                    values.push(src[(ny * width + nx) * 4 + channel]);
                }
                out.push(median_estimate(&values, percentile, quality));
            }
        }
    }
    Ok(out)
}

/// The slope `k` of Surface Blur's weight (FX-BLUR-SURFACE-03): `1 / (0.96 · T)` for the threshold
/// `T = threshold / 100`, so a neighbor differing by about `T` contributes nothing.
pub fn surface_slope(threshold: u32) -> Result<f32, String> {
    if !(1..=100).contains(&threshold) {
        return Err(format!("surface threshold must be 1-100, got {threshold}"));
    }
    Ok(1.0 / (0.96 * (threshold as f32 / 100.0)))
}

/// Surface Blur of a straight-alpha RGBA8 image (FX-BLUR-SURFACE-03). Each channel, alpha included,
/// is a weighted mean of the values in the disc of `radius`, with weight `max(0, 1 - |s - c| · k)`
/// on the 0-1 scale. Samples use the mirrored border. The center pixel always has weight 1, so the
/// total weight is never 0.
pub fn surface_blur_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    radius: u32,
    threshold: u32,
) -> Result<Vec<u8>, String> {
    if src.len() != width * height * 4 {
        return Err(format!("source must be {width}x{height} RGBA8"));
    }
    if radius > SURFACE_MAX_RADIUS {
        return Err(format!(
            "surface radius must be 0-{SURFACE_MAX_RADIUS}, got {radius}"
        ));
    }
    let slope = surface_slope(threshold)?;
    let offsets = disc(radius);
    let mut out = Vec::with_capacity(src.len());
    for y in 0..height {
        for x in 0..width {
            for channel in 0..4 {
                let center = f32::from(src[(y * width + x) * 4 + channel]) / 255.0;
                let mut sum = 0.0f32;
                let mut total = 0.0f32;
                for &(dx, dy) in &offsets {
                    let sx = mirror_index(x as isize + dx, width);
                    let sy = mirror_index(y as isize + dy, height);
                    let s = f32::from(src[(sy * width + sx) * 4 + channel]) / 255.0;
                    let w = (1.0 - (s - center).abs() * slope).max(0.0);
                    sum += w * s;
                    total += w;
                }
                out.push(to_byte(sum / total));
            }
        }
    }
    Ok(out)
}

/// Sketch Blur samples per iteration (FX-BLUR-SKETCH-03). Each iteration reads this many points of the
/// sparse scan, so the cost follows Smoothness and not the radius squared.
pub const SKETCH_SAMPLES: usize = 16;
/// The largest Sketch Blur Smoothness (FX-BLUR-SKETCH-02).
pub const SKETCH_MAX_SMOOTHNESS: u32 = 20;
/// The largest Sketch Blur radius (FX-BLUR-SKETCH-02).
pub const SKETCH_MAX_RADIUS: f32 = 100.0;
/// The golden angle in radians, which spaces the sparse scan around the disc.
const GOLDEN_ANGLE: f32 = 2.399_963;
/// Height units per gray level in Sketch Blur's P² estimator. Marker heights are integers in 1/64 level and
/// divisions truncate, so the estimator is exact integer arithmetic. Both backends then agree bit for bit,
/// where float comparisons at the branches of P² could flip between them.
const HEIGHT_UNITS: i32 = 64;
/// Units per marker position in Sketch Blur's estimator. At 200 units, the halves of the percentile
/// (`p / 2` and `(1 + p) / 2`) are still whole numbers.
const POSITION_UNITS: i32 = 200;

/// The sparse scan of Sketch Blur (FX-BLUR-SKETCH-03), as `dx, dy` pairs for `SKETCH_SAMPLES * smoothness`
/// points. Point `t` sits at distance `radius * sqrt((t + 0.5) / n)` and angle `t * golden angle`, so the
/// points spread evenly over the disc. The offsets are rounded once here, so both backends read the same
/// pixels.
pub fn sketch_offsets(radius: f32, smoothness: u32) -> Result<Vec<i32>, String> {
    if !(radius.is_finite() && (0.0..=SKETCH_MAX_RADIUS).contains(&radius)) {
        return Err(format!(
            "sketch radius must be 0-{SKETCH_MAX_RADIUS}, got {radius}"
        ));
    }
    if !(1..=SKETCH_MAX_SMOOTHNESS).contains(&smoothness) {
        return Err(format!(
            "sketch smoothness must be 1-{SKETCH_MAX_SMOOTHNESS}, got {smoothness}"
        ));
    }
    let count = SKETCH_SAMPLES * smoothness as usize;
    let mut offsets = Vec::with_capacity(2 * count);
    for t in 0..count {
        let distance = radius * ((t as f32 + 0.5) / count as f32).sqrt();
        let angle = t as f32 * GOLDEN_ANGLE;
        offsets.push((distance * angle.cos()).round() as i32);
        offsets.push((distance * angle.sin()).round() as i32);
    }
    Ok(offsets)
}

/// The P² constants of Sketch Blur for `percentile` (FX-BLUR-SKETCH-03), as 11 values. The first five are the
/// initial desired marker positions `1, 1 + 2p, 1 + 4p, 3 + 2p, 5`, each times `POSITION_UNITS`. The next five are the increments per
/// observation `0, p/2, p, (1 + p)/2, 1`, with `p = percentile / 100`. The last is the rank of the
/// sorted sample that seeds the first iteration, `floor(p * (SKETCH_SAMPLES - 1))`. The WGSL twin reads
/// the same values from its uniform.
pub fn sketch_plan(percentile: u32) -> Result<[i32; 11], String> {
    if percentile > 100 {
        return Err(format!(
            "sketch percentile must be 0-100, got {percentile}"
        ));
    }
    let p = percentile as i32;
    let rank = p * (SKETCH_SAMPLES as i32 - 1) / 100;
    Ok([
        POSITION_UNITS,
        POSITION_UNITS + 4 * p,
        POSITION_UNITS + 8 * p,
        3 * POSITION_UNITS + 4 * p,
        5 * POSITION_UNITS,
        0,
        p,
        2 * p,
        POSITION_UNITS / 2 + p,
        POSITION_UNITS,
        rank,
    ])
}

/// One Sketch Blur estimate of a channel (FX-BLUR-SKETCH-03). `sample(t)` reads the value at scan point `t`.
/// Each iteration feeds its `SKETCH_SAMPLES` points into a fresh P² estimator (Jain and Chlamtac, 1985),
/// seeded with the previous iteration's middle marker. The first iteration seeds with the sample of
/// rank `plan[10]`, and the middle marker after the last iteration is the result.
#[allow(clippy::needless_range_loop)]
fn sketch_estimate(sample: &dyn Fn(usize) -> i32, plan: &[i32; 11], iterations: usize) -> i32 {
    let init = [plan[0], plan[1], plan[2], plan[3], plan[4]];
    let step = [plan[5], plan[6], plan[7], plan[8], plan[9]];
    let rank = plan[10] as usize;
    let mut prev = 0i32;
    for pass in 0..iterations {
        let mut values = [0i32; SKETCH_SAMPLES];
        for (j, value) in values.iter_mut().enumerate() {
            *value = sample(pass * SKETCH_SAMPLES + j) * HEIGHT_UNITS;
        }
        if pass == 0 {
            prev = values
                .iter()
                .copied()
                .filter(|&v| values.iter().filter(|&&u| u <= v).count() > rank)
                .fold(i32::MAX, i32::min);
        }
        let lo = values.iter().copied().fold(i32::MAX, i32::min);
        let hi = values.iter().copied().fold(i32::MIN, i32::max);
        let mut q = [lo, (lo + prev) / 2, prev, (prev + hi) / 2, hi];
        let mut n = [1i32, 2, 3, 4, 5];
        let mut desired = init;
        for &x in &values {
            let mut k = 0;
            for i in 1..=3 {
                if x >= q[i] {
                    k = i;
                }
            }
            for i in k + 1..5 {
                n[i] += 1;
            }
            for i in 0..5 {
                desired[i] += step[i];
            }
            for i in 1..=3 {
                let d = desired[i] - n[i] * POSITION_UNITS;
                if (d >= POSITION_UNITS && n[i + 1] - n[i] > 1)
                    || (d <= -POSITION_UNITS && n[i - 1] - n[i] < -1)
                {
                    let s = if d > 0 { 1 } else { -1 };
                    let span = n[i + 1] - n[i - 1];
                    let right = (n[i] - n[i - 1] + s) * (q[i + 1] - q[i]) / (n[i + 1] - n[i]);
                    let left = (n[i + 1] - n[i] - s) * (q[i] - q[i - 1]) / (n[i] - n[i - 1]);
                    let parabolic = q[i] + s * (right + left) / span;
                    q[i] = if q[i - 1] < parabolic && parabolic < q[i + 1] {
                        parabolic
                    } else {
                        let j = if s > 0 { i + 1 } else { i - 1 };
                        q[i] + s * (q[j] - q[i]) / (n[j] - n[i])
                    };
                    n[i] += s;
                }
            }
        }
        prev = q[2];
    }
    prev
}

/// Sketch Blur (FX-BLUR-SKETCH) of a straight-alpha RGBA8 image. Each channel, alpha included, is the
/// `percentile` estimate of its values along the sparse scan of `radius`, refined over `smoothness`
/// iterations (see `sketch_estimate`). Samples use the mirrored border. The estimate runs on the
/// gamma-encoded values, as the spec's document working space.
pub fn sketch_blur_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    radius: f32,
    percentile: u32,
    smoothness: u32,
) -> Result<Vec<u8>, String> {
    if src.len() != width * height * 4 {
        return Err(format!("source must be {width}x{height} RGBA8"));
    }
    let offsets = sketch_offsets(radius, smoothness)?;
    let plan = sketch_plan(percentile)?;
    let iterations = smoothness as usize;
    let mut out = Vec::with_capacity(src.len());
    for y in 0..height {
        for x in 0..width {
            for channel in 0..4 {
                let sample = |t: usize| {
                    let sx = mirror_index(x as isize + offsets[2 * t] as isize, width);
                    let sy = mirror_index(y as isize + offsets[2 * t + 1] as isize, height);
                    i32::from(src[(sy * width + sx) * 4 + channel])
                };
                out.push(round_to_byte(sketch_estimate(&sample, &plan, iterations)));
            }
        }
    }
    Ok(out)
}

/// A 0-255 value as a byte, rounded half up.
fn round_to_byte(height: i32) -> u8 {
    ((height + HEIGHT_UNITS / 2) / HEIGHT_UNITS).clamp(0, 255) as u8
}

/// A 0-1 value as a byte, rounded half up.
fn to_byte(value: f32) -> u8 {
    (value * 255.0 + 0.5).floor().clamp(0.0, 255.0) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uniform(width: usize, height: usize, rgba: [u8; 4]) -> Vec<u8> {
        rgba.repeat(width * height)
    }

    /// A black opaque image with one bright pixel.
    fn spike(size: usize, x: usize, y: usize) -> Vec<u8> {
        let mut src = [0u8, 0, 0, 255].repeat(size * size);
        let index = (y * size + x) * 4;
        src[index..index + 4].copy_from_slice(&[255, 255, 255, 255]);
        src
    }

    #[test]
    fn disc_has_the_expected_size_and_contains_the_center() {
        assert_eq!(disc(0), vec![(0, 0)]);
        // Radius 1 is the plus shape, since (1, 1) lies at distance √2.
        assert_eq!(disc(1).len(), 5);
        assert!(disc(2).contains(&(2, 0)));
        assert!(!disc(2).contains(&(2, 1)));
        assert!(!disc(2).contains(&(2, 2)));
        assert!(disc(3).contains(&(2, 2)));
    }

    #[test]
    fn median_estimate_returns_the_percentile_of_the_values() {
        let values = [0u8, 0, 0, 255, 255];
        assert_eq!(median_estimate(&values, 50, 8), 0);
        assert_eq!(median_estimate(&values, 0, 8), 0);
        assert_eq!(median_estimate(&values, 100, 8), 255);
        assert_eq!(median_estimate(&[10, 20, 30], 50, 8), 20);
        assert_eq!(median_estimate(&[10, 20, 30], 100, 8), 30);
        assert_eq!(median_estimate(&[7, 7, 7], 33, 1), 7);
    }

    #[test]
    fn rank_estimate_takes_half_percent_ranks() {
        let values = [10u8, 20, 30, 40];
        assert_eq!(rank_estimate(&values, 0, 8), 10);
        assert_eq!(rank_estimate(&values, 200, 8), 40);
        assert_eq!(rank_estimate(&values, 100, 8), median_estimate(&values, 50, 8));
        let quarter = rank_estimate(&values, 50, 8);
        assert!((10..=20).contains(&quarter), "quarter rank {quarter}");
    }

    #[test]
    fn median_estimate_is_exact_at_eight_bits_for_every_percentile() {
        // Eight steps resolve finer than one level, so the search finds the exact percentile of 0..=255.
        let values: Vec<u8> = (0..=255u16).map(|v| v as u8).collect();
        for percentile in 0..=100u32 {
            let rank = (percentile * 256).div_ceil(100).max(1) as usize;
            assert_eq!(
                median_estimate(&values, percentile, 8),
                values[rank - 1],
                "p{percentile}"
            );
        }
    }

    #[test]
    fn median_removes_an_isolated_spike_and_percentile_100_dilates_it() {
        let src = spike(9, 4, 4);
        let eroded = median_blur_rgba8(&src, 9, 9, 2, 50, 8).unwrap();
        assert_eq!(eroded[(4 * 9 + 4) * 4], 0);
        let dilated = median_blur_rgba8(&src, 9, 9, 2, 100, 8).unwrap();
        // Every pixel within the radius 2 disc now reads the bright value.
        assert_eq!(dilated[(4 * 9 + 6) * 4], 255);
        assert_eq!(dilated[(4 * 9 + 7) * 4], 0);
    }

    #[test]
    fn uniform_images_and_radius_zero_pass_through() {
        let flat = uniform(12, 9, [30, 60, 90, 255]);
        assert_eq!(median_blur_rgba8(&flat, 12, 9, 4, 30, 8).unwrap(), flat);
        let src = spike(7, 2, 5);
        assert_eq!(median_blur_rgba8(&src, 7, 7, 0, 50, 8).unwrap(), src);
    }

    #[test]
    fn median_blur_keeps_a_step_edge() {
        // Left half 0, right half 255. Windows that stay on one side keep that side's value.
        let mut src = Vec::new();
        for _y in 0..6 {
            for x in 0..12 {
                let v = if x < 6 { 0 } else { 255 };
                src.extend_from_slice(&[v, v, v, 255]);
            }
        }
        let out = median_blur_rgba8(&src, 12, 6, 2, 50, 8).unwrap();
        assert_eq!(out[(3 * 12 + 2) * 4], 0);
        assert_eq!(out[(3 * 12 + 9) * 4], 255);
    }

    #[test]
    fn median_blur_alpha_is_a_channel_like_the_others() {
        let mut src = uniform(5, 5, [0, 0, 0, 255]);
        let index = (2 * 5 + 2) * 4;
        src[index + 3] = 0;
        let out = median_blur_rgba8(&src, 5, 5, 1, 50, 8).unwrap();
        assert_eq!(out[index + 3], 255);
    }

    #[test]
    fn invalid_median_inputs_are_rejected() {
        let src = uniform(2, 2, [1, 2, 3, 4]);
        assert!(median_blur_rgba8(&src, 2, 2, 101, 50, 8).is_err());
        assert!(median_blur_rgba8(&src, 2, 2, 4, 101, 8).is_err());
        assert!(median_blur_rgba8(&src, 2, 2, 4, 50, 0).is_err());
        assert!(median_blur_rgba8(&src, 2, 2, 4, 50, 10).is_err());
        assert!(median_blur_rgba8(&src, 3, 2, 4, 50, 8).is_err());
    }

    #[test]
    fn surface_slope_follows_the_threshold() {
        let slope = surface_slope(15).unwrap();
        assert!((slope - 1.0 / (0.96 * 0.15)).abs() < 1e-4, "{slope}");
        assert!(surface_slope(0).is_err());
        assert!(surface_slope(101).is_err());
    }

    #[test]
    fn surface_blur_of_a_uniform_image_is_unchanged() {
        let flat = uniform(11, 8, [70, 140, 210, 255]);
        assert_eq!(surface_blur_rgba8(&flat, 11, 8, 4, 15).unwrap(), flat);
    }

    #[test]
    fn surface_blur_keeps_a_sharp_step_edge() {
        // Neighbors across the edge differ by the full range, so their weight is 0.
        let mut src = Vec::new();
        for _y in 0..6 {
            for x in 0..12 {
                let v = if x < 6 { 0 } else { 255 };
                src.extend_from_slice(&[v, v, v, 255]);
            }
        }
        let out = surface_blur_rgba8(&src, 12, 6, 3, 15).unwrap();
        assert_eq!(out[(3 * 12 + 5) * 4], 0);
        assert_eq!(out[(3 * 12 + 6) * 4], 255);
    }

    #[test]
    fn surface_blur_smooths_a_small_difference() {
        // A difference of 13 levels is 0.051, which weighs the neighbors by about 0.65 at threshold 15.
        let mut src = uniform(7, 7, [0, 0, 0, 255]);
        for y in 0..7 {
            for x in 0..7 {
                if (x + y) % 2 == 1 {
                    src[(y * 7 + x) * 4] = 13;
                }
            }
        }
        let out = surface_blur_rgba8(&src, 7, 7, 2, 15).unwrap();
        let center = out[(3 * 7 + 3) * 4];
        assert!(center > 0 && center < 13, "{center}");
    }

    #[test]
    fn sketch_plan_matches_the_p_squared_constants() {
        let plan = sketch_plan(50).unwrap();
        assert_eq!(&plan[..5], &[200, 400, 600, 800, 1000]);
        assert_eq!(&plan[5..10], &[0, 50, 100, 150, 200]);
        assert_eq!(plan[10], 7);
        assert!(sketch_plan(101).is_err());
    }

    #[test]
    fn sketch_offsets_stay_within_the_disc_and_reject_bad_input() {
        let offsets = sketch_offsets(10.0, 2).unwrap();
        assert_eq!(offsets.len(), 2 * SKETCH_SAMPLES * 2);
        for pair in offsets.chunks(2) {
            let distance = ((pair[0] * pair[0] + pair[1] * pair[1]) as f32).sqrt();
            assert!(distance <= 11.0, "{distance}");
        }
        assert!(sketch_offsets(0.0, 1).unwrap().iter().all(|&v| v == 0));
        assert!(sketch_offsets(101.0, 1).is_err());
        assert!(sketch_offsets(5.0, 0).is_err());
    }

    #[test]
    fn sketch_estimate_tracks_the_percentile_of_a_ramp() {
        let plan = sketch_plan(50).unwrap();
        let value = sketch_estimate(&|t: usize| t as i32, &plan, 1);
        assert!((6 * HEIGHT_UNITS..=9 * HEIGHT_UNITS).contains(&value), "{value}");
    }

    #[test]
    fn sketch_keeps_uniform_images_and_radius_zero() {
        let flat = uniform(12, 9, [30, 60, 90, 255]);
        assert_eq!(sketch_blur_rgba8(&flat, 12, 9, 6.0, 20, 3).unwrap(), flat);
        let src = spike(7, 2, 5);
        assert_eq!(sketch_blur_rgba8(&src, 7, 7, 0.0, 50, 3).unwrap(), src);
    }

    #[test]
    fn sketch_low_percentile_keeps_a_lone_spike_out_of_a_dark_neighborhood() {
        let src = spike(15, 7, 7);
        let out = sketch_blur_rgba8(&src, 15, 15, 4.0, 20, 2).unwrap();
        assert_eq!(out[(7 * 15 + 7) * 4], 0);
    }

    #[test]
    fn invalid_sketch_inputs_are_rejected() {
        let src = uniform(2, 2, [1, 2, 3, 4]);
        assert!(sketch_blur_rgba8(&src, 2, 2, 101.0, 50, 3).is_err());
        assert!(sketch_blur_rgba8(&src, 2, 2, 4.0, 101, 3).is_err());
        assert!(sketch_blur_rgba8(&src, 2, 2, 4.0, 50, 0).is_err());
        assert!(sketch_blur_rgba8(&src, 2, 2, 4.0, 50, 21).is_err());
        assert!(sketch_blur_rgba8(&src, 3, 2, 4.0, 50, 3).is_err());
    }

    #[test]
    fn invalid_surface_inputs_are_rejected() {
        let src = uniform(2, 2, [1, 2, 3, 4]);
        assert!(surface_blur_rgba8(&src, 2, 2, 51, 15).is_err());
        assert!(surface_blur_rgba8(&src, 2, 2, 4, 0).is_err());
        assert!(surface_blur_rgba8(&src, 3, 2, 4, 15).is_err());
    }
}
