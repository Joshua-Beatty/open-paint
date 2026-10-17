//! Reference point adjustments (ADJ-INVCOL, ADJ-INVALPHA, ADJ-BW, ADJ-SEPIA). They
//! work on straight-alpha RGBA8 in the working space. The WGSL twin in `packages/effects` runs the
//! same integer and f32 steps in the same order, so GPU output must match these kernels within ±1
//! per channel.

use crate::blur::{kernel, mirror_index};
use crate::srgb::{to_linear, to_srgb};

/// Sepia exponents for R, G and B at intensity 50 (ADJ-SEPIA-01).
const SEPIA_TONE: [f32; 3] = [0.8, 1.0, 1.2];

/// Luma of 8-bit working-space values (ADJ-COMMON-06): `(19595 R + 38470 G + 7471 B) >> 16`.
pub fn luma8(r: u8, g: u8, b: u8) -> u8 {
    ((19595 * u32::from(r) + 38470 * u32::from(g) + 7471 * u32::from(b)) >> 16) as u8
}

/// The per-channel sepia exponents for `intensity` in 0..=100. Intensity 0 gives 1 (no toning),
/// 50 gives `SEPIA_TONE`, and 100 doubles each deviation from 1 (the proposed [TBD] curve of
/// ADJ-SEPIA-01). The engine's WGSL twin reads these values, so they are computed here only.
pub fn sepia_exponents(intensity: f32) -> [f32; 3] {
    let t = intensity / 50.0;
    SEPIA_TONE.map(|k| 1.0 + (k - 1.0) * t)
}

/// Applies `f` to every pixel of a straight-alpha RGBA8 buffer, in a copy.
fn map_pixels(src: &[u8], mut f: impl FnMut(&mut [u8; 4])) -> Result<Vec<u8>, String> {
    if !src.len().is_multiple_of(4) {
        return Err(format!("pixels must be RGBA8, got {} bytes", src.len()));
    }
    let mut out = src.to_vec();
    let (pixels, _) = out.as_chunks_mut::<4>();
    for pixel in pixels.iter_mut() {
        f(pixel);
    }
    Ok(out)
}

/// One sepia channel: `gray^exponent` on 0..=1, rounded half up to 8 bits. Zero stays zero.
fn sepia_channel(gray: f32, exponent: f32) -> u8 {
    let v = if gray > 0.0 { gray.powf(exponent) } else { 0.0 };
    (255.0 * v + 0.5).floor().clamp(0.0, 255.0) as u8
}

/// Invert Colors (ADJ-INVCOL-01): `c' = 255 - c` for R, G and B. Alpha is unchanged.
pub fn invert_colors(src: &[u8]) -> Result<Vec<u8>, String> {
    map_pixels(src, |px| {
        px[0] = 255 - px[0];
        px[1] = 255 - px[1];
        px[2] = 255 - px[2];
    })
}

/// Invert Alpha (ADJ-INVALPHA-01): `a' = 255 - a`. The color channels are unchanged.
pub fn invert_alpha(src: &[u8]) -> Result<Vec<u8>, String> {
    map_pixels(src, |px| px[3] = 255 - px[3])
}

/// Black and White (ADJ-BW-01): R, G and B become the luma. Alpha is unchanged.
pub fn black_and_white(src: &[u8]) -> Result<Vec<u8>, String> {
    map_pixels(src, |px| {
        let y = luma8(px[0], px[1], px[2]);
        px[0] = y;
        px[1] = y;
        px[2] = y;
    })
}

/// Sepia (ADJ-SEPIA-01): the luma `g` is toned per channel as `g^exponent`. Intensity 0 equals
/// Black and White. Alpha is unchanged.
pub fn sepia(src: &[u8], intensity: f32) -> Result<Vec<u8>, String> {
    if !(intensity.is_finite() && (0.0..=100.0).contains(&intensity)) {
        return Err(format!("intensity must be 0..=100, got {intensity}"));
    }
    let exponents = sepia_exponents(intensity);
    map_pixels(src, |px| {
        let gray = f32::from(luma8(px[0], px[1], px[2])) / 255.0;
        for (channel, exponent) in exponents.iter().enumerate() {
            px[channel] = sepia_channel(gray, *exponent);
        }
    })
}

/// Histogram bins per channel (ADJ-AUTOLEVEL-01).
const BINS: usize = 256;
/// The black and white percentiles of Auto-Level (ADJ-AUTOLEVEL-01): 0.5 % and 99.5 %.
const BLACK_PERCENTILE: f64 = 0.005;
const WHITE_PERCENTILE: f64 = 0.995;
/// The gamma range of Auto-Level (ADJ-AUTOLEVEL-01).
const GAMMA_MIN: f64 = 0.1;
const GAMMA_MAX: f64 = 10.0;

/// The Auto-Level plan (ADJ-AUTOLEVEL-01 steps 2-4): for each of R, G and B, the input black
/// point, the input white point and the gamma, all on 0..=1 and in that order.
/// Levels per channel, R then G then B: input black, input white, gamma, output black and output
/// white (ADJ-LEVELS-PARAMS). Auto-Level uses output 0 and 1.
pub type LevelsPlan = [f32; 15];

/// The number of plan values per channel (see `LevelsPlan`).
pub const LEVELS_PER_CHANNEL: usize = 5;

/// Converts a value on 0..=1 to 8 bits, rounded half up, with clamping.
fn unit_to_u8(v: f32) -> u8 {
    (255.0 * v.clamp(0.0, 1.0) + 0.5).floor() as u8
}

fn check_range(name: &str, value: f32, min: f32, max: f32) -> Result<(), String> {
    if value.is_finite() && (min..=max).contains(&value) {
        Ok(())
    } else {
        Err(format!("{name} must be {min}..={max}, got {value}"))
    }
}

fn check_contrast_range(name: &str, value: f32) -> Result<(), String> {
    check_range(name, value, -100.0, 100.0)
}

/// The numbers Brightness / Contrast computes from its two parameters (ADJ-BC-01): the brightness
/// shift `B / 255`, the multiplier `mul` and the divisor `div`. The WGSL twin reads these values.
pub fn brightness_contrast_plan(brightness: f32, contrast: f32) -> Result<[f32; 3], String> {
    check_contrast_range("brightness", brightness)?;
    check_contrast_range("contrast", contrast)?;
    let (mul, div) = if contrast < 0.0 {
        (contrast + 100.0, 100.0)
    } else if contrast > 0.0 {
        (100.0, 100.0 - contrast)
    } else {
        (1.0, 1.0)
    };
    Ok([brightness / 255.0, mul, div])
}

/// Brightness / Contrast (ADJ-BC-01) on straight-alpha RGBA8 in the working space. Alpha is kept.
pub fn brightness_contrast(src: &[u8], brightness: f32, contrast: f32) -> Result<Vec<u8>, String> {
    let [bright, mul, div] = brightness_contrast_plan(brightness, contrast)?;
    map_pixels(src, |px| {
        let r = f32::from(px[0]) / 255.0;
        let g = f32::from(px[1]) / 255.0;
        let b = f32::from(px[2]) / 255.0;
        let y = 0.299 * r + 0.587 * g + 0.114 * b;
        if div == 0.0 {
            let gray = if y + bright >= 0.5 { 255 } else { 0 };
            px[0] = gray;
            px[1] = gray;
            px[2] = gray;
            return;
        }
        let (pre, post) = if div == 100.0 {
            (0.0, bright)
        } else {
            (bright, 0.0)
        };
        let shift = ((y - 0.5 + pre) * mul / div) + (0.5 - y + post);
        px[0] = unit_to_u8(r + shift);
        px[1] = unit_to_u8(g + shift);
        px[2] = unit_to_u8(b + shift);
    })
}

/// The Levels transform of one channel value on 0..=1 (ADJ-LEVELS-MATH), before clamping.
fn level_value(v: f32, levels: [f32; LEVELS_PER_CHANNEL]) -> f32 {
    let [low, high, gamma, out_low, out_high] = levels;
    if v < low {
        out_low
    } else if v >= high {
        out_high
    } else {
        let base = (v - low) / (high - low);
        let t = if base <= 0.0 { 0.0 } else { base.powf(gamma) };
        out_low + (out_high - out_low) * t
    }
}

/// The value at which the cumulative count first reaches `target` (a percentile of the bins).
fn percentile_bin(hist: &[u64; BINS], target: f64) -> usize {
    let mut cumulative = 0u64;
    for (value, count) in hist.iter().enumerate() {
        cumulative += count;
        if cumulative as f64 >= target {
            return value;
        }
    }
    BINS - 1
}

/// The black point, white point and gamma of one channel (ADJ-AUTOLEVEL-01 steps 2-3). With no
/// pixels, the transform is the identity.
fn channel_levels(hist: &[u64; BINS], sum: u64, count: u64) -> [f32; 3] {
    if count == 0 {
        return [0.0, 1.0, 1.0];
    }
    let n = count as f64;
    let black = percentile_bin(hist, BLACK_PERCENTILE * n) as f64 / 255.0;
    let white = percentile_bin(hist, WHITE_PERCENTILE * n) as f64 / 255.0;
    let mean = sum as f64 / n / 255.0;
    let gamma = if black < mean && mean < white {
        let t = (mean - black) / (white - black);
        ((0.5f64).ln() / t.ln()).clamp(GAMMA_MIN, GAMMA_MAX)
    } else {
        1.0
    };
    [black as f32, white as f32, gamma as f32]
}

/// The per-channel histograms of the covered pixels, with each channel's sum and the covered count.
struct Histograms {
    bins: [[u64; BINS]; 3],
    sums: [u64; 3],
    count: u64,
}

/// Counts the pixels of straight-alpha RGBA8 `src` that `coverage` selects (nonzero coverage).
fn histograms(src: &[u8], coverage: &[u8]) -> Result<Histograms, String> {
    if !src.len().is_multiple_of(4) {
        return Err(format!("pixels must be RGBA8, got {} bytes", src.len()));
    }
    let (pixels, _) = src.as_chunks::<4>();
    if coverage.len() != pixels.len() {
        return Err(format!(
            "coverage has {} pixels; expected {}",
            coverage.len(),
            pixels.len()
        ));
    }
    let mut out = Histograms {
        bins: [[0u64; BINS]; 3],
        sums: [0u64; 3],
        count: 0,
    };
    for (px, &c) in pixels.iter().zip(coverage) {
        if c == 0 {
            continue;
        }
        out.count += 1;
        for (channel, bins) in out.bins.iter_mut().enumerate() {
            let value = px[channel];
            bins[usize::from(value)] += 1;
            out.sums[channel] += u64::from(value);
        }
    }
    Ok(out)
}

/// The per-channel histograms of the covered pixels, R then G then B, 256 bins each (ADJ-LEVELS-UI-06).
pub fn levels_histogram(src: &[u8], coverage: &[u8]) -> Result<Vec<u32>, String> {
    let Histograms { bins, .. } = histograms(src, coverage)?;
    Ok(bins
        .iter()
        .flatten()
        .map(|&count| u32::try_from(count).unwrap_or(u32::MAX))
        .collect())
}

/// The Auto-Level plan (ADJ-AUTOLEVEL-01) from the pixels that `coverage` selects. A coverage of 0
/// excludes a pixel from the histograms, and nonzero coverage includes it.
pub fn auto_level_plan(src: &[u8], coverage: &[u8]) -> Result<LevelsPlan, String> {
    let Histograms { bins, sums, count } = histograms(src, coverage)?;
    let mut plan = [0f32; 15];
    for channel in 0..3 {
        let [low, high, gamma] = channel_levels(&bins[channel], sums[channel], count);
        let start = channel * LEVELS_PER_CHANNEL;
        plan[start..start + LEVELS_PER_CHANNEL].copy_from_slice(&[low, high, gamma, 0.0, 1.0]);
    }
    Ok(plan)
}

/// The Levels transform of each channel as a lookup table. Entry `channel * 256 + value` is the
/// output of `value` in that channel. `plan` holds the `LevelsPlan` values, R then G then B.
pub fn levels_lut(plan: &[f32]) -> Result<Vec<u8>, String> {
    if plan.len() != 3 * LEVELS_PER_CHANNEL {
        return Err(format!(
            "the Levels plan has {} values; expected {}",
            plan.len(),
            3 * LEVELS_PER_CHANNEL
        ));
    }
    let mut lut = vec![0u8; 3 * BINS];
    let (channels, _) = plan.as_chunks::<LEVELS_PER_CHANNEL>();
    for (channel, &levels) in channels.iter().enumerate() {
        for value in 0..BINS {
            let v = value as f32 / 255.0;
            lut[channel * BINS + value] = unit_to_u8(level_value(v, levels));
        }
    }
    Ok(lut)
}

/// The Levels transform (ADJ-LEVELS-MATH) of each color channel of straight-alpha RGBA8, with the
/// plan of `levels_lut`. Alpha is kept.
pub fn levels(src: &[u8], plan: &[f32]) -> Result<Vec<u8>, String> {
    let lut = levels_lut(plan)?;
    map_pixels(src, |px| {
        for channel in 0..3 {
            px[channel] = lut[channel * BINS + usize::from(px[channel])];
        }
    })
}

/// Auto-Level (ADJ-AUTOLEVEL-01) on straight-alpha RGBA8. The histograms read only the pixels that
/// `coverage` selects (ADJ-COMMON-05), and every pixel is then mapped by the plan. Alpha is kept.
pub fn auto_level(src: &[u8], coverage: &[u8]) -> Result<Vec<u8>, String> {
    let plan = auto_level_plan(src, coverage)?;
    levels(src, &plan)
}

/// One third and one sixth, the hue sector bounds of the HSL conversion (ADJ-HUESAT-01).
const ONE_THIRD: f32 = 1.0 / 3.0;
const ONE_SIXTH: f32 = 1.0 / 6.0;
const TWO_THIRDS: f32 = 2.0 / 3.0;

/// The numbers Hue / Saturation computes from its three parameters (ADJ-HUESAT-01): the hue turn
/// `hue / 360`, the saturation factor `f`, the lightness weight `|lightness| / 100` and the
/// lightness target (1 for a lightening, 0 for a darkening). The WGSL twin reads these values.
pub fn hue_saturation_plan(hue: f32, saturation: f32, lightness: f32) -> Result<[f32; 4], String> {
    check_range("hue", hue, -180.0, 180.0)?;
    check_range("saturation", saturation, 0.0, 200.0)?;
    check_range("lightness", lightness, -100.0, 100.0)?;
    let factor = if saturation <= 100.0 {
        saturation / 100.0
    } else {
        1.0 + 3.0 * (saturation / 100.0 - 1.0)
    };
    let target = if lightness >= 0.0 { 1.0 } else { 0.0 };
    Ok([hue / 360.0, factor, lightness.abs() / 100.0, target])
}

/// RGB on 0..=1 to HSL, with H on 0..1 (ADJ-HUESAT-01 step 1). Gray has S = 0 and H = 0.
fn rgb_to_hsl(r: f32, g: f32, b: f32) -> [f32; 3] {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) * 0.5;
    let d = max - min;
    if d == 0.0 {
        return [0.0, 0.0, l];
    }
    let s = if l > 0.5 {
        d / (2.0 - max - min)
    } else {
        d / (max + min)
    };
    let h = if max == r {
        let mut h = (g - b) / d;
        if g < b {
            h += 6.0;
        }
        h
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    [h / 6.0, s, l]
}

/// One of the three HSL-to-RGB channels for a hue offset `t` (wraps once in either direction).
fn hue_to_channel(p: f32, q: f32, t: f32) -> f32 {
    let t = if t < 0.0 {
        t + 1.0
    } else if t > 1.0 {
        t - 1.0
    } else {
        t
    };
    if t < ONE_SIXTH {
        p + (q - p) * 6.0 * t
    } else if t < 0.5 {
        q
    } else if t < TWO_THIRDS {
        p + (q - p) * (TWO_THIRDS - t) * 6.0
    } else {
        p
    }
}

/// HSL to RGB on 0..=1 (ADJ-HUESAT-01 step 3).
fn hsl_to_rgb(h: f32, s: f32, l: f32) -> [f32; 3] {
    if s == 0.0 {
        return [l, l, l];
    }
    let q = if l < 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let p = 2.0 * l - q;
    [
        hue_to_channel(p, q, h + ONE_THIRD),
        hue_to_channel(p, q, h),
        hue_to_channel(p, q, h - ONE_THIRD),
    ]
}

/// Hue / Saturation (ADJ-HUESAT-01) on straight-alpha RGBA8 in the working space. Alpha is kept.
pub fn hue_saturation(
    src: &[u8],
    hue: f32,
    saturation: f32,
    lightness: f32,
) -> Result<Vec<u8>, String> {
    let plan = hue_saturation_plan(hue, saturation, lightness)?;
    map_pixels(src, |px| {
        let r = f32::from(px[0]) / 255.0;
        let g = f32::from(px[1]) / 255.0;
        let b = f32::from(px[2]) / 255.0;
        let [h, s, l] = rgb_to_hsl(r, g, b);
        let h = h + plan[0];
        let h = h - h.floor();
        let s = (s * plan[1]).clamp(0.0, 1.0);
        let [r, g, b] = hsl_to_rgb(h, s, l);
        px[0] = unit_to_u8(r + (plan[3] - r) * plan[2]);
        px[1] = unit_to_u8(g + (plan[3] - g) * plan[2]);
        px[2] = unit_to_u8(b + (plan[3] - b) * plan[2]);
    })
}

/// Posterize (ADJ-POSTERIZE-01) with `levels` for R, G, B and A. A level of 0 leaves that channel
/// alone, and any other level must be 2..=64. Each enabled channel maps to its nearest of the
/// evenly spaced levels, and alpha changes only when its level is set.
pub fn posterize(src: &[u8], levels: &[u32]) -> Result<Vec<u8>, String> {
    let levels = <[u32; 4]>::try_from(levels)
        .map_err(|_| format!("posterize takes four levels, got {}", levels.len()))?;
    for &n in &levels {
        if n != 0 && !(2..=64).contains(&n) {
            return Err(format!("posterize levels must be 0 or 2..=64, got {n}"));
        }
    }
    map_pixels(src, |px| {
        for (channel, &n) in levels.iter().enumerate() {
            if n != 0 {
                px[channel] = posterize_channel(px[channel], n);
            }
        }
    })
}

/// One channel quantized to `n` levels: `round(v (n - 1)) / (n - 1)` on 0..=1, then to 8 bits.
fn posterize_channel(c: u8, n: u32) -> u8 {
    let steps = (n - 1) as f32;
    let v = f32::from(c) / 255.0;
    unit_to_u8((v * steps + 0.5).floor() / steps)
}

/// Entries in one curve's lookup table, sampled over input 0..=1 (ADJ-CURVES-MATH-02).
pub const CURVE_LUT_SIZE: usize = 1024;
/// Curve tables of `curves`: the luminosity curve, then red, green and blue.
pub const CURVE_TABLES: usize = 4;

/// The lookup table of one curve (ADJ-CURVES-MATH-01/02). `points` holds the control points as
/// x, y pairs on 0..=255 with unique x. The natural cubic spline through them is sampled over input
/// 0..=1, flat beyond the end points, and clamped to 0..=1.
pub fn curve_lut(points: &[u8]) -> Result<Vec<f32>, String> {
    let (pairs, rest) = points.as_chunks::<2>();
    if pairs.is_empty() || !rest.is_empty() {
        return Err(format!(
            "a curve needs one or more (x, y) pairs, got {} values",
            points.len()
        ));
    }
    let mut sorted = pairs.to_vec();
    sorted.sort_unstable_by_key(|point| point[0]);
    if sorted.windows(2).any(|pair| pair[0][0] == pair[1][0]) {
        return Err("curve points need unique x values".to_string());
    }
    let xs: Vec<f64> = sorted.iter().map(|p| f64::from(p[0]) / 255.0).collect();
    let ys: Vec<f64> = sorted.iter().map(|p| f64::from(p[1]) / 255.0).collect();
    let second = spline_second_derivatives(&xs, &ys);
    Ok((0..CURVE_LUT_SIZE)
        .map(|k| {
            let t = k as f64 / (CURVE_LUT_SIZE - 1) as f64;
            spline_at(&xs, &ys, &second, t).clamp(0.0, 1.0) as f32
        })
        .collect())
}

/// The second derivatives at the points of the natural cubic spline (zero at both ends).
fn spline_second_derivatives(xs: &[f64], ys: &[f64]) -> Vec<f64> {
    let n = xs.len();
    let mut m = vec![0.0; n];
    if n < 3 {
        return m;
    }
    let unknowns = n - 2;
    let mut cp = vec![0.0; unknowns];
    let mut dp = vec![0.0; unknowns];
    for j in 0..unknowns {
        let i = j + 1;
        let h0 = xs[i] - xs[i - 1];
        let h1 = xs[i + 1] - xs[i];
        let rhs = 6.0 * ((ys[i + 1] - ys[i]) / h1 - (ys[i] - ys[i - 1]) / h0);
        let (prev_c, prev_d) = if j == 0 {
            (0.0, 0.0)
        } else {
            (cp[j - 1], dp[j - 1])
        };
        let denom = 2.0 * (h0 + h1) - h0 * prev_c;
        cp[j] = h1 / denom;
        dp[j] = (rhs - h0 * prev_d) / denom;
    }
    let mut next = 0.0;
    for j in (0..unknowns).rev() {
        next = dp[j] - cp[j] * next;
        m[j + 1] = next;
    }
    m
}

/// The spline at `t`, flat beyond the first and last points.
fn spline_at(xs: &[f64], ys: &[f64], m: &[f64], t: f64) -> f64 {
    let n = xs.len();
    if t <= xs[0] {
        return ys[0];
    }
    if t >= xs[n - 1] {
        return ys[n - 1];
    }
    let i = (xs.partition_point(|&x| x <= t) - 1).min(n - 2);
    let h = xs[i + 1] - xs[i];
    let a = (xs[i + 1] - t) / h;
    let b = (t - xs[i]) / h;
    a * ys[i] + b * ys[i + 1] + ((a * a * a - a) * m[i] + (b * b * b - b) * m[i + 1]) * h * h / 6.0
}

/// A curve's output for input `v` on 0..=1, linearly interpolated in its table. The WGSL twin
/// reads the same table with the same steps.
fn curve_value(lut: &[f32], v: f32) -> f32 {
    let pos = v.clamp(0.0, 1.0) * (CURVE_LUT_SIZE - 1) as f32;
    let i = (pos.floor() as usize).min(CURVE_LUT_SIZE - 2);
    let f = pos - i as f32;
    lut[i] + (lut[i + 1] - lut[i]) * f
}

/// Pulls linear-light channels toward `target` along the gray axis until they fit in 0..=1
/// (ADJ-CURVES-MATH-04): first the low side, then the high side, measured after the first pull.
fn pull_into_range(mut c: [f32; 3], target: f32) -> [f32; 3] {
    let low = c[0].min(c[1]).min(c[2]);
    if low < 0.0 {
        for v in &mut c {
            *v = target + (*v - target) * target / (target - low);
        }
    }
    let high = c[0].max(c[1]).max(c[2]);
    if high > 1.0 {
        for v in &mut c {
            *v = target + (*v - target) * (1.0 - target) / (high - target);
        }
    }
    c
}

/// The Exposure gain for `value` in −200..=200 (ADJ-EXPOSURE-01): `2^(value / 100)`, so EV = value / 100.
pub fn exposure_gain(value: f32) -> Result<f32, String> {
    check_range("exposure", value, -200.0, 200.0)?;
    Ok((value / 100.0).exp2())
}

/// Multiplies each channel's linear-light value by its gain, clamps to 0..=1 and re-encodes to the
/// working space. Alpha is kept.
fn scale_linear(src: &[u8], gains: [f32; 3]) -> Result<Vec<u8>, String> {
    map_pixels(src, |px| {
        for (channel, gain) in gains.iter().enumerate() {
            let linear = (to_linear(f32::from(px[channel]) / 255.0) * *gain).clamp(0.0, 1.0);
            px[channel] = unit_to_u8(to_srgb(linear));
        }
    })
}

/// Exposure (ADJ-EXPOSURE-01) of straight-alpha RGBA8 for `value` in −200..=200. Processing is in
/// linear light.
pub fn exposure(src: &[u8], value: f32) -> Result<Vec<u8>, String> {
    let gain = exposure_gain(value)?;
    scale_linear(src, [gain; 3])
}

/// The per-channel linear-light gains of Temperature / Tint (ADJ-TT-02) for the two values in
/// −100..=100. `t` and `n` are the values over 100, and the gains are divided by their Rec. 709
/// luminance so the overall brightness stays put. (0, 0) gives gains of exactly one.
pub fn temperature_tint_gains(temperature: f32, tint: f32) -> Result<[f32; 3], String> {
    check_contrast_range("temperature", temperature)?;
    check_contrast_range("tint", tint)?;
    let t = temperature / 100.0;
    let n = tint / 100.0;
    let gains = [
        (0.5 * t - 0.25 * n).exp2(),
        (0.5 * n).exp2(),
        (-0.5 * t - 0.25 * n).exp2(),
    ];
    let luminance = 0.2126 * gains[0] + 0.7152 * gains[1] + 0.0722 * gains[2];
    Ok(gains.map(|gain| gain / luminance))
}

/// Temperature / Tint (ADJ-TT-01, ADJ-TT-02) of straight-alpha RGBA8 for the two values in
/// −100..=100. Alpha is kept.
pub fn temperature_tint(src: &[u8], temperature: f32, tint: f32) -> Result<Vec<u8>, String> {
    scale_linear(src, temperature_tint_gains(temperature, tint)?)
}

/// The Highlights / Shadows / Clarity values of ADJ-HS-02 step 3 and 4, each −100..=100 over 100
/// (so −1..=1). The WGSL twin reads these values.
pub fn highlights_shadows_plan(
    highlights: f32,
    shadows: f32,
    clarity: f32,
) -> Result<[f32; 3], String> {
    check_contrast_range("highlights", highlights)?;
    check_contrast_range("shadows", shadows)?;
    check_contrast_range("clarity", clarity)?;
    Ok([highlights, shadows, clarity].map(|value| value / 100.0))
}

/// The Radius range of Highlights / Shadows (ADJ-HS table).
const HS_RADIUS_MAX: f32 = 10.0;

/// The smoothstep of ADJ-HS-02 step 2, `t * t * (3 - 2t)` on `t` clamped to 0..=1.
fn smooth_unit(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// The luma after ADJ-HS-02 steps 2-4 for luma `y` and blurred luma `m`, clamped to 0..=1.
fn highlights_luma(y: f32, m: f32, [highlights, shadows, clarity]: [f32; 3]) -> f32 {
    let s = 1.0 - smooth_unit(0.0, 0.5, m);
    let shadow_weight = s * s;
    let h = smooth_unit(0.5, 1.0, m);
    let highlight_weight = h * h;
    let shadow_term = if shadows > 0.0 { (1.0 - y) * y } else { y * y };
    let highlight_term = if highlights > 0.0 {
        (1.0 - y) * (1.0 - y)
    } else {
        y * (1.0 - y)
    };
    let y1 =
        y + shadows * shadow_weight * shadow_term + highlights * highlight_weight * highlight_term;
    let y2 = y1 + clarity * 0.5 * (y1 - m) * 4.0 * m * (1.0 - m);
    y2.clamp(0.0, 1.0)
}

/// Luma of 8-bit working-space values on 0..=1, in f32 (ADJ-COMMON-06, non-linear).
fn luma_unit(r: u8, g: u8, b: u8) -> f32 {
    let rf = f32::from(r) / 255.0;
    let gf = f32::from(g) / 255.0;
    let bf = f32::from(b) / 255.0;
    0.299 * rf + 0.587 * gf + 0.114 * bf
}

/// Blurs `values` (`width` by `height`, row-major) with the symmetric weights `weights`, using a
/// mirror border. The horizontal pass runs first, then the vertical one, as the WGSL twin does.
fn blur_values(values: &[f32], width: usize, height: usize, weights: &[f32]) -> Vec<f32> {
    let radius = (weights.len() / 2) as isize;
    let mut rows = vec![0.0_f32; values.len()];
    for (index, out) in rows.iter_mut().enumerate() {
        let x = index % width;
        let row = index - x;
        let mut sum = 0.0_f32;
        for (k, weight) in weights.iter().enumerate() {
            let sx = mirror_index(x as isize + k as isize - radius, width);
            sum += weight * values[row + sx];
        }
        *out = sum;
    }
    let mut out = vec![0.0_f32; values.len()];
    for (index, dst) in out.iter_mut().enumerate() {
        let x = index % width;
        let y = index / width;
        let mut sum = 0.0_f32;
        for (k, weight) in weights.iter().enumerate() {
            let sy = mirror_index(y as isize + k as isize - radius, height);
            sum += weight * rows[sy * width + x];
        }
        *dst = sum;
    }
    out
}

/// The blurred luma `M` of ADJ-HS-02 step 1: the luma blurred with σ = 2 × radius pixels. Radius 0
/// leaves the luma unchanged.
pub fn highlights_mask(src: &[u8], width: usize, height: usize, radius: f32) -> Vec<f32> {
    let luma: Vec<f32> = src
        .as_chunks::<4>()
        .0
        .iter()
        .map(|px| luma_unit(px[0], px[1], px[2]))
        .collect();
    blur_values(&luma, width, height, &kernel(2.0 * radius))
}

/// Highlights / Shadows / Clarity (ADJ-HS-01, ADJ-HS-02) of straight-alpha RGBA8 that is `width`
/// by `height`. `radius` is 0..=10, and the three amounts are −100..=100. The luma moves in linear
/// light, with the luma-preserving clip of ADJ-CURVES-MATH-04. Alpha is kept.
pub fn highlights_shadows(
    src: &[u8],
    width: usize,
    height: usize,
    radius: f32,
    highlights: f32,
    shadows: f32,
    clarity: f32,
) -> Result<Vec<u8>, String> {
    check_range("radius", radius, 0.0, HS_RADIUS_MAX)?;
    let tone = highlights_shadows_plan(highlights, shadows, clarity)?;
    if src.len() != width * height * 4 {
        return Err(format!(
            "a {width}x{height} image holds {} bytes; expected {}",
            src.len(),
            width * height * 4
        ));
    }
    let mask = highlights_mask(src, width, height, radius);
    let mut out = src.to_vec();
    for (px, m) in out.as_chunks_mut::<4>().0.iter_mut().zip(mask) {
        let y = luma_unit(px[0], px[1], px[2]);
        let target = to_linear(highlights_luma(y, m, tone));
        let delta = target - to_linear(y);
        let linear = [0, 1, 2].map(|channel| to_linear(f32::from(px[channel]) / 255.0) + delta);
        let c = pull_into_range(linear, target);
        for (channel, v) in c.iter().enumerate() {
            px[channel] = unit_to_u8(to_srgb(v.clamp(0.0, 1.0)));
        }
    }
    Ok(out)
}

/// The Curves transform (ADJ-CURVES-MATH-03, -04) of straight-alpha RGBA8 in the working space.
/// `tables` holds the `CURVE_TABLES` lookup tables of `curve_lut`: luminosity, then red, green and
/// blue. With `rgb` false, the luminosity table moves R, G and B by the change of luma, and the
/// channels are then pulled toward that luma until they fit in 0..=1. With `rgb` true, each color
/// channel passes through its own table. Alpha is kept.
pub fn curves(src: &[u8], rgb: bool, tables: &[f32]) -> Result<Vec<u8>, String> {
    if tables.len() != CURVE_TABLES * CURVE_LUT_SIZE {
        return Err(format!(
            "the curve tables hold {} values; expected {}",
            tables.len(),
            CURVE_TABLES * CURVE_LUT_SIZE
        ));
    }
    let (luminosity, channels) = tables.split_at(CURVE_LUT_SIZE);
    if rgb {
        return map_pixels(src, |px| {
            for (channel, lut) in channels.as_chunks::<CURVE_LUT_SIZE>().0.iter().enumerate() {
                px[channel] = unit_to_u8(curve_value(lut, f32::from(px[channel]) / 255.0));
            }
        });
    }
    map_pixels(src, |px| {
        let r = f32::from(px[0]) / 255.0;
        let g = f32::from(px[1]) / 255.0;
        let b = f32::from(px[2]) / 255.0;
        let y = 0.299 * r + 0.587 * g + 0.114 * b;
        let target = curve_value(luminosity, y);
        let delta = target - y;
        let c = pull_into_range([r + delta, g + delta, b + delta], target);
        for (channel, v) in c.iter().enumerate() {
            px[channel] = unit_to_u8(*v);
        }
    })
}

#[cfg(test)]
mod curve_tests {
    use super::*;

    const IDENTITY: [u8; 4] = [0, 0, 255, 255];

    fn table(points: &[u8]) -> Vec<f32> {
        curve_lut(points).unwrap()
    }

    fn tables(luminosity: &[u8], red: &[u8], green: &[u8], blue: &[u8]) -> Vec<f32> {
        [luminosity, red, green, blue]
            .iter()
            .flat_map(|points| table(points))
            .collect()
    }

    fn identity_tables() -> Vec<f32> {
        tables(&IDENTITY, &IDENTITY, &IDENTITY, &IDENTITY)
    }

    fn luma(px: &[u8]) -> f32 {
        0.299 * f32::from(px[0]) + 0.587 * f32::from(px[1]) + 0.114 * f32::from(px[2])
    }

    #[test]
    fn identity_lut_is_the_input_ramp() {
        let lut = table(&IDENTITY);
        assert_eq!(lut.len(), CURVE_LUT_SIZE);
        for (k, value) in lut.iter().enumerate() {
            assert!((value - k as f32 / 1023.0).abs() < 1e-6, "entry {k}");
        }
    }

    #[test]
    fn spline_passes_through_its_points() {
        let lut = table(&[0, 0, 128, 40, 255, 255]);
        assert!((curve_value(&lut, 128.0 / 255.0) - 40.0 / 255.0).abs() < 2e-3);
        assert!(lut[0].abs() < 1e-6);
        assert!((lut[1023] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn spline_is_flat_beyond_the_end_points() {
        let lut = table(&[50, 100, 200, 150]);
        assert!((lut[0] - 100.0 / 255.0).abs() < 1e-6);
        assert!((lut[1023] - 150.0 / 255.0).abs() < 1e-6);
    }

    #[test]
    fn spline_is_clamped_to_the_unit_range() {
        let lut = table(&[0, 0, 100, 255, 255, 0]);
        assert!(lut.iter().all(|v| (0.0..=1.0).contains(v)));
    }

    #[test]
    fn rejects_unusable_points() {
        assert!(curve_lut(&[]).is_err());
        assert!(curve_lut(&[0, 0, 5]).is_err());
        assert!(curve_lut(&[0, 0, 0, 9]).is_err());
    }

    #[test]
    fn identity_curves_leave_every_pixel_alone() {
        let src = [0, 0, 0, 0, 12, 200, 255, 255, 130, 60, 5, 128];
        assert_eq!(
            curves(&src, false, &identity_tables()).unwrap(),
            src.to_vec()
        );
        assert_eq!(
            curves(&src, true, &identity_tables()).unwrap(),
            src.to_vec()
        );
    }

    #[test]
    fn luminosity_clips_to_white_and_black_and_keeps_alpha() {
        let white = tables(&[0, 255, 255, 255], &IDENTITY, &IDENTITY, &IDENTITY);
        assert_eq!(
            curves(&[10, 20, 30, 40], false, &white).unwrap(),
            vec![255, 255, 255, 40]
        );
        let black = tables(&[0, 0, 255, 0], &IDENTITY, &IDENTITY, &IDENTITY);
        assert_eq!(
            curves(&[200, 100, 50, 7], false, &black).unwrap(),
            vec![0, 0, 0, 7]
        );
    }

    #[test]
    fn luminosity_clipping_keeps_the_target_luma() {
        let points = [0, 0, 128, 200, 255, 255];
        let lut = tables(&points, &IDENTITY, &IDENTITY, &IDENTITY);
        let lum = table(&points);
        let src = [120, 60, 30, 255, 250, 250, 20, 255];
        let out = curves(&src, false, &lut).unwrap();
        for (px, original) in out
            .as_chunks::<4>()
            .0
            .iter()
            .zip(src.as_chunks::<4>().0.iter())
        {
            let target = curve_value(&lum, luma(original) / 255.0) * 255.0;
            assert!((luma(px) - target).abs() <= 1.5, "{px:?} against {target}");
            assert_eq!(px[3], original[3]);
        }
    }

    #[test]
    fn rgb_mode_applies_each_channel_its_own_table() {
        let invert_red = [0, 255, 255, 0];
        let lut = tables(&IDENTITY, &invert_red, &IDENTITY, &IDENTITY);
        assert_eq!(
            curves(&[10, 100, 200, 77], true, &lut).unwrap(),
            vec![245, 100, 200, 77]
        );
    }

    #[test]
    fn rejects_tables_of_the_wrong_size() {
        assert!(curves(&[0, 0, 0, 255], false, &[0.0; 10]).is_err());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn luma_uses_the_fixed_point_weights() {
        assert_eq!(luma8(255, 255, 255), 255);
        assert_eq!(luma8(0, 0, 0), 0);
        assert_eq!(luma8(255, 0, 0), 76);
        assert_eq!(luma8(0, 255, 0), 149);
        assert_eq!(luma8(0, 0, 255), 29);
    }

    #[test]
    fn invert_colors_keeps_alpha_and_inverts_hidden_color() {
        let src = [10, 20, 30, 255, 200, 100, 0, 0];
        assert_eq!(
            invert_colors(&src),
            Ok(vec![245, 235, 225, 255, 55, 155, 255, 0])
        );
    }

    #[test]
    fn invert_alpha_keeps_color() {
        let src = [10, 20, 30, 255, 200, 100, 0, 0];
        assert_eq!(
            invert_alpha(&src),
            Ok(vec![10, 20, 30, 0, 200, 100, 0, 255])
        );
    }

    #[test]
    fn black_and_white_writes_the_luma_and_keeps_alpha() {
        let src = [255, 0, 0, 128, 0, 0, 0, 0];
        assert_eq!(black_and_white(&src), Ok(vec![76, 76, 76, 128, 0, 0, 0, 0]));
    }

    #[test]
    fn sepia_exponents_follow_the_intensity_scale() {
        assert_eq!(sepia_exponents(0.0), [1.0, 1.0, 1.0]);
        let mid = sepia_exponents(50.0);
        assert!((mid[0] - 0.8).abs() < 1e-6 && mid[1] == 1.0 && (mid[2] - 1.2).abs() < 1e-6);
        let full = sepia_exponents(100.0);
        assert!((full[0] - 0.6).abs() < 1e-6 && (full[2] - 1.4).abs() < 1e-6);
    }

    #[test]
    fn sepia_at_zero_intensity_is_black_and_white() {
        let src: Vec<u8> = (0..64u8)
            .flat_map(|i| [i * 4, 255 - i * 3, i * 2, i * 3])
            .collect();
        assert_eq!(sepia(&src, 0.0), black_and_white(&src));
    }

    #[test]
    fn sepia_tones_mid_gray_warm_and_keeps_alpha() {
        let out = sepia(&[128, 128, 128, 77], 50.0).unwrap();
        assert!(out[0] > out[1] && out[1] > out[2], "{out:?}");
        assert_eq!(out[3], 77);
        assert_eq!(sepia(&[0, 0, 0, 0], 100.0), Ok(vec![0, 0, 0, 0]));
        assert_eq!(
            sepia(&[255, 255, 255, 255], 100.0),
            Ok(vec![255, 255, 255, 255])
        );
    }

    #[test]
    fn rejects_invalid_arguments() {
        assert!(invert_colors(&[1, 2, 3]).is_err());
        assert!(invert_alpha(&[1, 2, 3, 4, 5]).is_err());
        assert!(black_and_white(&[1, 2, 3]).is_err());
        assert!(sepia(&[0; 4], -1.0).is_err());
        assert!(sepia(&[0; 4], 101.0).is_err());
        assert!(sepia(&[0; 4], f32::NAN).is_err());
        assert!(sepia(&[0; 3], 50.0).is_err());
    }

    fn gray_ramp(values: &[u8]) -> Vec<u8> {
        values.iter().flat_map(|&v| [v, v, v, 255]).collect()
    }

    #[test]
    fn brightness_contrast_at_zero_is_the_identity() {
        let src: Vec<u8> = (0..=255u8)
            .flat_map(|i| [i, 255 - i, i / 2, i.wrapping_mul(3)])
            .collect();
        assert_eq!(brightness_contrast(&src, 0.0, 0.0), Ok(src));
    }

    #[test]
    fn brightness_adds_the_shift_to_each_channel() {
        let out = brightness_contrast(&[0, 0, 0, 90], 100.0, 0.0).unwrap();
        assert_eq!(out, vec![100, 100, 100, 90]);
        let out = brightness_contrast(&[200, 100, 50, 7], -100.0, 0.0).unwrap();
        assert_eq!(out, vec![100, 0, 0, 7]);
    }

    #[test]
    fn full_contrast_thresholds_the_luma_to_black_or_white() {
        let out = brightness_contrast(&gray_ramp(&[50, 200]), 0.0, 100.0).unwrap();
        assert_eq!(out, vec![0, 0, 0, 255, 255, 255, 255, 255]);
        let out = brightness_contrast(&[200, 200, 200, 33], 0.0, 100.0).unwrap();
        assert_eq!(out, vec![255, 255, 255, 33]);
    }

    #[test]
    fn contrast_pushes_away_from_mid_gray_and_keeps_hue() {
        let out = brightness_contrast(&[200, 150, 100, 255], 0.0, 50.0).unwrap();
        assert!(out[0] > 200, "{out:?}");
        assert!(out[0] > out[1] && out[1] > out[2], "{out:?}");
        let flat = brightness_contrast(&[128, 128, 128, 255], 0.0, 80.0).unwrap();
        assert_eq!(flat[0], flat[1]);
        assert_eq!(flat[1], flat[2]);
    }

    #[test]
    fn minimum_contrast_turns_every_color_to_mid_gray() {
        let out = brightness_contrast(&[10, 200, 90, 255], 0.0, -100.0).unwrap();
        let luma =
            0.299 * f32::from(out[0]) + 0.587 * f32::from(out[1]) + 0.114 * f32::from(out[2]);
        assert!((luma - 127.5).abs() <= 2.0, "{out:?}");
    }

    #[test]
    fn brightness_contrast_keeps_alpha_and_rejects_bad_arguments() {
        let out = brightness_contrast(&[60, 60, 60, 0], 80.0, 40.0).unwrap();
        assert_eq!(out[3], 0);
        assert!(brightness_contrast(&[0; 4], 101.0, 0.0).is_err());
        assert!(brightness_contrast(&[0; 4], 0.0, f32::NAN).is_err());
        assert!(brightness_contrast(&[0; 3], 0.0, 0.0).is_err());
        assert_eq!(brightness_contrast_plan(0.0, 0.0), Ok([0.0, 1.0, 1.0]));
        assert_eq!(
            brightness_contrast_plan(100.0, -50.0),
            Ok([100.0 / 255.0, 50.0, 100.0])
        );
    }

    #[test]
    fn auto_level_stretches_the_range_to_full() {
        let values: Vec<u8> = (50..=200).collect();
        let out = auto_level(&gray_ramp(&values), &vec![255; values.len()]).unwrap();
        assert_eq!(&out[0..4], &[0, 0, 0, 255]);
        let last = out.len() - 4;
        assert_eq!(&out[last..last + 3], &[255, 255, 255]);
        assert_eq!(out[3], 255);
    }

    #[test]
    fn auto_level_gamma_brightens_dark_images_and_darkens_bright_ones() {
        let dark: Vec<u8> = (0..=100).chain(0..=20).collect();
        let dark_plan = auto_level_plan(&gray_ramp(&dark), &vec![255; dark.len()]).unwrap();
        assert!(dark_plan[2] < 1.0, "{dark_plan:?}");
        let bright: Vec<u8> = (155..=255).chain(235..=255).collect();
        let bright_plan = auto_level_plan(&gray_ramp(&bright), &vec![255; bright.len()]).unwrap();
        assert!(bright_plan[2] > 1.0, "{bright_plan:?}");
    }

    #[test]
    fn auto_level_reads_only_the_selected_pixels() {
        let selected: Vec<u8> = (60..=140).collect();
        let outliers = [0u8, 0, 255, 255];
        let mut full = gray_ramp(&selected);
        full.extend(gray_ramp(&outliers));
        let mut coverage = vec![255u8; selected.len()];
        coverage.extend([0u8; 4]);
        let masked = auto_level_plan(&full, &coverage).unwrap();
        let subset = auto_level_plan(&gray_ramp(&selected), &vec![255; selected.len()]).unwrap();
        assert_eq!(masked, subset);
        let whole = auto_level_plan(&full, &vec![255; full.len() / 4]).unwrap();
        assert_ne!(whole, subset);
        let out = auto_level(&full, &coverage).unwrap();
        let expected = auto_level(&gray_ramp(&selected), &vec![255; selected.len()]).unwrap();
        assert_eq!(&out[..expected.len()], &expected[..]);
    }

    #[test]
    fn auto_level_without_selected_pixels_is_the_identity() {
        let src = gray_ramp(&[10, 90, 200]);
        assert_eq!(auto_level(&src, &[0, 0, 0]), Ok(src.clone()));
        assert_eq!(auto_level_plan(&src, &[0, 0, 0]), Ok(IDENTITY_PLAN));
    }

    #[test]
    fn auto_level_keeps_alpha_and_rejects_mismatched_coverage() {
        let src = [30, 30, 30, 0, 220, 220, 220, 90];
        let out = auto_level(&src, &[255, 255]).unwrap();
        assert_eq!(out[3], 0);
        assert_eq!(out[7], 90);
        assert!(auto_level(&src, &[255]).is_err());
        assert!(auto_level(&[1, 2, 3], &[]).is_err());
    }

    #[test]
    fn hue_saturation_at_zero_is_the_identity() {
        let src: Vec<u8> = (0..=255u8)
            .step_by(5)
            .flat_map(|i| [i, 255 - i, i / 3, 90])
            .collect();
        assert_eq!(hue_saturation(&src, 0.0, 100.0, 0.0), Ok(src));
    }

    #[test]
    fn hue_turns_red_to_cyan_at_180_and_keeps_alpha() {
        let out = hue_saturation(&[255, 0, 0, 200], 180.0, 100.0, 0.0).unwrap();
        assert!(out[0] <= 1 && out[1] >= 254 && out[2] >= 254, "{out:?}");
        assert_eq!(out[3], 200);
    }

    #[test]
    fn hue_wraps_so_both_ends_of_the_range_match() {
        let src = [200u8, 90, 40, 255, 30, 60, 220, 255];
        let low = hue_saturation(&src, -180.0, 100.0, 0.0).unwrap();
        let high = hue_saturation(&src, 180.0, 100.0, 0.0).unwrap();
        for (a, b) in low.iter().zip(&high) {
            assert!(a.abs_diff(*b) <= 1, "{low:?} {high:?}");
        }
    }

    #[test]
    fn saturation_zero_makes_gray_and_above_100_amplifies() {
        let gray = hue_saturation(&[200, 100, 40, 255], 0.0, 0.0, 0.0).unwrap();
        assert_eq!(gray, vec![120, 120, 120, 255]);
        let base = hue_saturation(&[200, 100, 100, 255], 0.0, 100.0, 0.0).unwrap();
        let boosted = hue_saturation(&[200, 100, 100, 255], 0.0, 150.0, 0.0).unwrap();
        assert!(
            boosted[0] - boosted[1] > base[0] - base[1],
            "{base:?} {boosted:?}"
        );
    }

    #[test]
    fn lightness_reaches_white_and_black_and_keeps_alpha() {
        let src = [30u8, 90, 200, 17];
        assert_eq!(
            hue_saturation(&src, 0.0, 100.0, 100.0),
            Ok(vec![255, 255, 255, 17])
        );
        assert_eq!(
            hue_saturation(&src, 0.0, 100.0, -100.0),
            Ok(vec![0, 0, 0, 17])
        );
        let half = hue_saturation(&[0, 0, 0, 255], 0.0, 100.0, 50.0).unwrap();
        assert_eq!(half[0], 128);
    }

    #[test]
    fn hue_saturation_plan_gives_the_factor_and_target() {
        assert_eq!(
            hue_saturation_plan(90.0, 150.0, -40.0),
            Ok([0.25, 2.5, 0.4, 0.0])
        );
        assert_eq!(
            hue_saturation_plan(0.0, 100.0, 0.0),
            Ok([0.0, 1.0, 0.0, 1.0])
        );
    }

    #[test]
    fn hue_saturation_rejects_bad_arguments() {
        assert!(hue_saturation(&[0; 4], 181.0, 100.0, 0.0).is_err());
        assert!(hue_saturation(&[0; 4], 0.0, -1.0, 0.0).is_err());
        assert!(hue_saturation(&[0; 4], 0.0, 201.0, 0.0).is_err());
        assert!(hue_saturation(&[0; 4], 0.0, 100.0, f32::NAN).is_err());
        assert!(hue_saturation(&[0; 3], 0.0, 100.0, 0.0).is_err());
    }

    #[test]
    fn posterize_two_levels_is_black_or_white() {
        let src = [0u8, 127, 128, 255, 127, 128, 60, 200];
        assert_eq!(
            posterize(&src, &[2, 2, 2, 0]),
            Ok(vec![0, 0, 255, 255, 0, 255, 0, 200])
        );
    }

    #[test]
    fn posterize_snaps_to_the_nearest_even_level() {
        assert_eq!(
            posterize(&[100, 200, 0, 9], &[4, 4, 4, 0]),
            Ok(vec![85, 170, 0, 9])
        );
    }

    #[test]
    fn posterize_leaves_disabled_channels_and_alpha_alone() {
        let src = [100u8, 200, 30, 77];
        assert_eq!(posterize(&src, &[0, 0, 0, 0]), Ok(src.to_vec()));
        assert_eq!(posterize(&src, &[2, 0, 0, 0]), Ok(vec![0, 200, 30, 77]));
        assert_eq!(posterize(&src, &[2, 0, 0, 2]), Ok(vec![0, 200, 30, 0]));
    }

    #[test]
    fn posterize_rejects_bad_levels() {
        assert!(posterize(&[0; 4], &[2, 2, 2]).is_err());
        assert!(posterize(&[0; 4], &[1, 0, 0, 0]).is_err());
        assert!(posterize(&[0; 4], &[65, 0, 0, 0]).is_err());
        assert!(posterize(&[0; 3], &[2, 2, 2, 0]).is_err());
    }

    /// The identity Levels plan: black 0, white 1, gamma 1 and output 0 to 1 for each channel.
    const IDENTITY_PLAN: [f32; 15] = [
        0.0, 1.0, 1.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0,
    ];

    #[test]
    fn levels_maps_each_channel_with_its_own_points() {
        // R is the identity, G has its white point at 0.5, and B has its black point at 0.2.
        let plan = [
            0.0, 1.0, 1.0, 0.0, 1.0, 0.0, 0.5, 1.0, 0.0, 1.0, 0.2, 1.0, 1.0, 0.0, 1.0,
        ];
        let out = levels(&[128, 128, 128, 40], &plan).unwrap();
        assert_eq!(out[0], 128);
        assert_eq!(out[1], 255);
        assert!((95..=97).contains(&out[2]), "blue was {}", out[2]);
        assert_eq!(out[3], 40);
    }

    #[test]
    fn levels_output_points_scale_the_result() {
        // R maps black to 0.2 and white to 0.8 of the output range.
        let plan = [
            0.0, 1.0, 1.0, 0.2, 0.8, 0.0, 1.0, 1.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0,
        ];
        let out = levels(&[0, 0, 0, 9, 255, 255, 255, 9], &plan).unwrap();
        assert_eq!(out, vec![51, 0, 0, 9, 204, 255, 255, 9]);
    }

    #[test]
    fn levels_lut_matches_the_applied_transform() {
        let plan = [
            0.1, 0.9, 2.0, 0.0, 1.0, 0.0, 1.0, 0.5, 0.3, 0.8, 0.2, 0.7, 1.0, 0.0, 1.0,
        ];
        let lut = levels_lut(&plan).unwrap();
        assert_eq!(lut.len(), 3 * BINS);
        for value in 0..=255u8 {
            let out = levels(&[value, value, value, 255], &plan).unwrap();
            for (channel, &got) in out.iter().take(3).enumerate() {
                assert_eq!(got, lut[channel * BINS + usize::from(value)]);
            }
        }
    }

    #[test]
    fn levels_identity_is_unchanged_and_keeps_alpha() {
        let src: Vec<u8> = (0..=255u8)
            .step_by(17)
            .flat_map(|v| [v, 255 - v, v / 2, v])
            .collect();
        assert_eq!(levels(&src, &IDENTITY_PLAN), Ok(src.clone()));
    }

    #[test]
    fn levels_rejects_a_plan_of_the_wrong_length() {
        assert!(levels(&[0; 4], &[0.0; 8]).is_err());
        assert!(levels_lut(&[0.0; 10]).is_err());
    }

    #[test]
    fn levels_histogram_counts_only_the_covered_pixels() {
        let src = [10, 20, 30, 255, 10, 20, 30, 0];
        let bins = levels_histogram(&src, &[255, 0]).unwrap();
        assert_eq!(bins.len(), 3 * BINS);
        assert_eq!(bins[10], 1);
        assert_eq!(bins[BINS + 20], 1);
        assert_eq!(bins[2 * BINS + 30], 1);
        assert_eq!(bins.iter().sum::<u32>(), 3);
        assert!(levels_histogram(&src, &[255]).is_err());
    }
}

#[cfg(test)]
mod tone_tests {
    use super::*;

    fn gray_pixels(values: &[u8]) -> Vec<u8> {
        values.iter().flat_map(|&v| [v, v, v, 255]).collect()
    }

    #[test]
    fn exposure_zero_is_the_identity_on_every_gray_level() {
        let src = gray_pixels(&(0..=255).collect::<Vec<u8>>());
        assert_eq!(exposure(&src, 0.0), Ok(src.clone()));
    }

    #[test]
    fn exposure_gain_is_two_to_the_ev() {
        assert_eq!(exposure_gain(100.0), Ok(2.0));
        assert_eq!(exposure_gain(-100.0), Ok(0.5));
        assert!(exposure_gain(201.0).is_err());
        assert!(exposure_gain(f32::NAN).is_err());
    }

    #[test]
    fn exposure_doubles_linear_light_and_clamps() {
        let out = exposure(&gray_pixels(&[64, 255]), 100.0).unwrap();
        let expected = (255.0 * to_srgb(2.0 * to_linear(64.0 / 255.0))).round() as u8;
        assert_eq!(out[0], expected);
        assert_eq!(out[4], 255);
    }

    #[test]
    fn exposure_keeps_alpha_and_hidden_color() {
        let out = exposure(&[40, 80, 120, 0, 40, 80, 120, 128], -200.0).unwrap();
        assert_eq!(out[3], 0);
        assert_eq!(out[7], 128);
        assert!(out[0] < 40 && out[4] < 40);
    }

    #[test]
    fn temperature_zero_is_the_identity() {
        let src: Vec<u8> = (0..=255u8).flat_map(|v| [v, 255 - v, v / 2, v]).collect();
        assert_eq!(temperature_tint(&src, 0.0, 0.0), Ok(src.clone()));
        let gains = temperature_tint_gains(0.0, 0.0).unwrap();
        assert!(
            gains.iter().all(|gain| (gain - 1.0).abs() < 1e-6),
            "{gains:?}"
        );
    }

    #[test]
    fn warm_temperature_raises_red_and_lowers_blue() {
        let out = temperature_tint(&gray_pixels(&[128]), 100.0, 0.0).unwrap();
        assert!(out[0] > 128 && out[2] < 128, "{out:?}");
        let cool = temperature_tint(&gray_pixels(&[128]), -100.0, 0.0).unwrap();
        assert!(cool[0] < 128 && cool[2] > 128, "{cool:?}");
    }

    #[test]
    fn positive_tint_raises_green_and_lowers_magenta() {
        let out = temperature_tint(&gray_pixels(&[128]), 0.0, 100.0).unwrap();
        assert!(out[1] > 128 && out[0] < 128 && out[2] < 128, "{out:?}");
    }

    #[test]
    fn temperature_gains_keep_luminance() {
        let gains = temperature_tint_gains(60.0, -40.0).unwrap();
        let luminance = 0.2126 * gains[0] + 0.7152 * gains[1] + 0.0722 * gains[2];
        assert!((luminance - 1.0).abs() < 1e-6, "{luminance}");
    }

    #[test]
    fn highlights_zero_is_the_identity() {
        let src: Vec<u8> = (0..20u8)
            .flat_map(|v| [v * 12, v * 7, 255 - v * 5, v * 9])
            .collect();
        let out = highlights_shadows(&src, 5, 4, 2.5, 0.0, 0.0, 0.0).unwrap();
        assert_eq!(out, src);
    }

    #[test]
    fn highlights_brightens_bright_pixels_and_leaves_dark_ones() {
        let src = gray_pixels(&[20, 230]);
        let out = highlights_shadows(&src, 2, 1, 0.0, 100.0, 0.0, 0.0).unwrap();
        assert_eq!(out[0], 20);
        assert!(out[4] > 230, "{out:?}");
    }

    #[test]
    fn negative_shadows_darkens_dark_pixels_only() {
        let src = gray_pixels(&[40, 230]);
        let out = highlights_shadows(&src, 2, 1, 0.0, 0.0, -100.0, 0.0).unwrap();
        assert!(out[0] < 40, "{out:?}");
        assert_eq!(out[4], 230);
    }

    #[test]
    fn highlights_keep_alpha_and_stay_in_range() {
        let src = [200, 200, 200, 0, 250, 240, 230, 128];
        let out = highlights_shadows(&src, 2, 1, 1.25, 100.0, 0.0, 100.0).unwrap();
        assert_eq!(out[3], 0);
        assert_eq!(out[7], 128);
    }

    #[test]
    fn mask_without_radius_is_the_luma() {
        let src = [255, 0, 0, 255, 0, 255, 0, 255];
        assert_eq!(
            highlights_mask(&src, 2, 1, 0.0),
            vec![luma_unit(255, 0, 0), luma_unit(0, 255, 0)]
        );
    }

    #[test]
    fn mask_of_a_flat_image_is_flat() {
        let src = gray_pixels(&[77; 12]);
        let mask = highlights_mask(&src, 4, 3, 3.0);
        assert!(
            mask.iter().all(|m| (m - 77.0 / 255.0).abs() < 1e-6),
            "{mask:?}"
        );
    }

    #[test]
    fn mask_blurs_an_edge_across_the_boundary() {
        let src = gray_pixels(&[0, 255]);
        let mask = highlights_mask(&src, 2, 1, 1.0);
        assert!(mask[0] > 0.0 && mask[1] < 1.0, "{mask:?}");
    }

    #[test]
    fn highlights_plans_reject_out_of_range_values() {
        assert_eq!(
            highlights_shadows_plan(50.0, -100.0, 100.0),
            Ok([0.5, -1.0, 1.0])
        );
        assert!(highlights_shadows_plan(101.0, 0.0, 0.0).is_err());
        assert!(highlights_shadows(&gray_pixels(&[1]), 1, 1, 11.0, 0.0, 0.0, 0.0).is_err());
    }

    #[test]
    fn pull_into_range_fits_both_sides_on_the_gray_axis() {
        let low = pull_into_range([-0.2, 0.5, 0.6], 0.4);
        assert!(
            low.iter().fold(f32::MAX, |a, &b| a.min(b)).abs() < 1e-6,
            "{low:?}"
        );
        let high = pull_into_range([0.9, 1.3, 0.6], 0.7);
        assert!(
            (high.iter().fold(f32::MIN, |a, &b| a.max(b)) - 1.0).abs() < 1e-6,
            "{high:?}"
        );
        assert_eq!(pull_into_range([0.2, 0.5, 0.8], 0.5), [0.2, 0.5, 0.8]);
    }
}
