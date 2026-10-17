//! Bokeh Blur (FX-BLUR-BOKEH). The WGSL twin in `packages/effects` runs the same steps on the
//! weights computed here, so GPU output must match this reference within ±1 per channel.
//!
//! The flat disc of radius R is approximated by K separable complex Gaussian terms, the
//! "complex-kernel bokeh" proposal of FX-BLUR-BOKEH-03. Term k is `c_k · exp(-ρ_k (x² + y²) / R²)`,
//! and the kernel is the real part of the sum. The pixel pass computes, per term, one vertical complex
//! convolution and one horizontal convolution that accumulates the real part, so the cost is linear
//! in Quality. The coefficients are a least-squares fit to the disc profile.
//!
//! Pipeline: gamma(e) on straight color, premultiply, the term sum with a mirror border, unpremultiply,
//! inverse gamma, as Gaussian (`blur::gamma_pipeline`).

use crate::blur::{check_separable_args, gamma_pipeline, mirror_index, Texel};

/// The largest Quality, which is the number of complex terms (FX-BLUR-BOKEH-02).
pub const MAX_QUALITY: u8 = 10;

/// Radii below this pass through. A disc of radius below 1 px holds only the center pixel.
pub const MIN_RADIUS: f32 = 1.0;

/// Samples of the disc profile that the terms are fitted to.
const FIT_SAMPLES: usize = 400;
/// The fit covers `u` in `0..=max(FIT_MIN_REACH, (half_width / R)²)`, where `u = r² / R²`. Two reaches the
/// corners of the square support, so the terms are also zero outside the disc at the corners.
const FIT_MIN_REACH: f64 = 2.0;

/// The decay rate `ρ = a + ib` of term `index`. The first `quality` terms are used, so a higher Quality
/// adds terms and never changes the earlier ones.
fn rate(index: usize) -> (f64, f64) {
    let k = index as f64;
    (1.0, 0.5 + std::f64::consts::PI * k)
}

/// `a · b` for complex numbers as `(re, im)`.
fn cmul(a: (f64, f64), b: (f64, f64)) -> (f64, f64) {
    (a.0 * b.0 - a.1 * b.1, a.0 * b.1 + a.1 * b.0)
}

/// `exp(-ρ u)` for the rate `ρ = (a, b)` at `u >= 0`, as `(re, im)`.
fn decay((a, b): (f64, f64), u: f64) -> (f64, f64) {
    let magnitude = (-a * u).exp();
    let (sin, cos) = (b * u).sin_cos();
    (magnitude * cos, -magnitude * sin)
}

/// One row of the least-squares system at `u`: the real part of `e^{-ρ_k u}` for each term, then the
/// real part of `-i e^{-ρ_k u}` (the weight of `Im c_k`).
fn basis_row(rates: &[(f64, f64)], u: f64) -> Vec<f64> {
    let quality = rates.len();
    let mut row = vec![0.0; 2 * quality];
    for (k, &rho) in rates.iter().enumerate() {
        let (re, im) = decay(rho, u);
        row[k] = re;
        row[quality + k] = -im;
    }
    row
}

/// Solves `a x = b` by Gaussian elimination with partial pivoting.
fn solve(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Vec<f64> {
    let n = b.len();
    for col in 0..n {
        let pivot = (col..n)
            .max_by(|&i, &j| a[i][col].abs().total_cmp(&a[j][col].abs()))
            .unwrap_or(col);
        a.swap(col, pivot);
        b.swap(col, pivot);
        let pivot_row = a[col].clone();
        let pivot_value = b[col];
        for (row, rhs) in a.iter_mut().zip(b.iter_mut()).skip(col + 1) {
            let factor = row[col] / pivot_row[col];
            for (cell, &p) in row[col..].iter_mut().zip(&pivot_row[col..]) {
                *cell -= factor * p;
            }
            *rhs -= factor * pivot_value;
        }
    }
    let mut x = vec![0.0; n];
    for row in (0..n).rev() {
        let tail: f64 = a[row][row + 1..]
            .iter()
            .zip(&x[row + 1..])
            .map(|(coefficient, value)| coefficient * value)
            .sum();
        x[row] = (b[row] - tail) / a[row][row];
    }
    x
}

/// The least-squares coefficients `c_k` (as `(re, im)`) of `quality` terms for the disc profile:
/// `1` for `u <= 1` and `0` beyond, sampled on `0..=reach`.
fn fit_terms(rates: &[(f64, f64)], reach: f64) -> Vec<(f64, f64)> {
    let quality = rates.len();
    let n = 2 * quality;
    let mut normal = vec![vec![0.0; n]; n];
    let mut rhs = vec![0.0; n];
    for j in 0..FIT_SAMPLES {
        let u = reach * j as f64 / (FIT_SAMPLES - 1) as f64;
        let target = if u <= 1.0 { 1.0 } else { 0.0 };
        let row = basis_row(rates, u);
        for (a, &ra) in row.iter().enumerate() {
            rhs[a] += ra * target;
            for (cell, &rb) in normal[a].iter_mut().zip(&row) {
                *cell += ra * rb;
            }
        }
    }
    for (a, row) in normal.iter_mut().enumerate() {
        row[a] += 1e-12;
    }
    let x = solve(normal, rhs);
    (0..quality).map(|k| (x[k], x[quality + k])).collect()
}

/// The sum of the fitted terms at `u`, which approximates the disc profile.
#[cfg(test)]
fn fitted_profile(rates: &[(f64, f64)], coefficients: &[(f64, f64)], u: f64) -> f64 {
    coefficients
        .iter()
        .zip(rates)
        .map(|(&c, &rho)| cmul(c, decay(rho, u)).0)
        .sum()
}

/// The root-mean-square error of the fitted profile against the disc over `0..=FIT_MIN_REACH`.
#[cfg(test)]
fn fit_error(rates: &[(f64, f64)]) -> f64 {
    let coefficients = fit_terms(rates, FIT_MIN_REACH);
    let squares: f64 = (0..FIT_SAMPLES)
        .map(|j| {
            let u = FIT_MIN_REACH * j as f64 / (FIT_SAMPLES - 1) as f64;
            let target = if u <= 1.0 { 1.0 } else { 0.0 };
            (fitted_profile(rates, &coefficients, u) - target).powi(2)
        })
        .sum();
    (squares / FIT_SAMPLES as f64).sqrt()
}

/// The sampled kernel of a Bokeh Blur: the taps of each term's vertical and horizontal weights.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    /// Taps run over `-half_width..=half_width`.
    pub half_width: usize,
    /// Vertical weights `g_k(d)` of each term, `2·half_width + 1` taps per term.
    pub vertical: Vec<[f32; 2]>,
    /// Horizontal weights `c_k · g_k(d)` of each term, scaled so the kernel sums to 1.
    pub horizontal: Vec<[f32; 2]>,
}

impl Plan {
    /// Flattens the plan as the vertical weights then the horizontal weights, each as `re, im` pairs.
    pub fn flatten(&self) -> Vec<f32> {
        self.vertical
            .iter()
            .chain(&self.horizontal)
            .flatten()
            .copied()
            .collect()
    }
}

/// The tap half-width for `radius`, `ceil(radius)`, so every pixel inside the disc is reached.
pub fn half_width(radius: f32) -> usize {
    radius.ceil() as usize
}

/// Builds the kernel of Bokeh Blur (FX-BLUR-BOKEH-03) for `radius` (at least `MIN_RADIUS`) and `quality`.
/// Each term's horizontal weights include its coefficient, and the scale makes the summed kernel exactly
/// 1 on the discrete support.
pub fn plan(radius: f32, quality: u8) -> Result<Plan, String> {
    if !(1..=MAX_QUALITY).contains(&quality) {
        return Err(format!("quality must be 1-{MAX_QUALITY}, got {quality}"));
    }
    if !(radius.is_finite() && radius >= MIN_RADIUS) {
        return Err(format!(
            "radius must be a finite value >= {MIN_RADIUS}, got {radius}"
        ));
    }
    let terms = usize::from(quality);
    let r = f64::from(radius);
    let half = half_width(radius);
    let taps = 2 * half + 1;
    let reach = (half as f64 / r).powi(2).max(FIT_MIN_REACH);
    let rates: Vec<(f64, f64)> = (0..terms).map(rate).collect();
    let coefficients = fit_terms(&rates, reach);

    let mut vertical = Vec::with_capacity(terms * taps);
    let mut weighted = Vec::with_capacity(terms);
    let mut total = 0.0;
    for (&rho, &c) in rates.iter().zip(&coefficients) {
        let g: Vec<(f64, f64)> = (0..taps)
            .map(|t| {
                let d = t as f64 - half as f64;
                decay(rho, d * d / (r * r))
            })
            .collect();
        let sum = g
            .iter()
            .fold((0.0, 0.0), |(re, im), &(gr, gi)| (re + gr, im + gi));
        total += cmul(c, cmul(sum, sum)).0;
        vertical.extend(g.iter().map(|&(re, im)| [re as f32, im as f32]));
        weighted.push((c, g));
    }
    if !(total.is_finite() && total.abs() > 1e-12) {
        return Err(format!(
            "the Bokeh kernel of radius {radius} cannot be normalized"
        ));
    }
    let horizontal = weighted
        .iter()
        .flat_map(|(c, g)| {
            g.iter().map(move |&(gr, gi)| {
                let (re, im) = cmul(*c, (gr, gi));
                [(re / total) as f32, (im / total) as f32]
            })
        })
        .collect();
    Ok(Plan {
        half_width: half,
        vertical,
        horizontal,
    })
}

/// The flattened kernel for the WASM export (see `Plan::flatten`).
pub fn plan_values(radius: f32, quality: u8) -> Result<Vec<f32>, String> {
    plan(radius, quality).map(|plan| plan.flatten())
}

/// Applies the Bokeh kernel to a premultiplied linear plane with a mirror border. Each term first runs
/// a vertical complex pass, then a horizontal pass that accumulates the real part into the output.
fn filter(plane: &[Texel], width: usize, height: usize, plan: &Plan) -> Vec<Texel> {
    let half = plan.half_width as isize;
    let taps = 2 * plan.half_width + 1;
    let mut out = vec![[0.0f32; 4]; width * height];
    let mut v_re = vec![[0.0f32; 4]; width * height];
    let mut v_im = vec![[0.0f32; 4]; width * height];
    for term in 0..plan.vertical.len() / taps {
        let g = &plan.vertical[term * taps..(term + 1) * taps];
        let h = &plan.horizontal[term * taps..(term + 1) * taps];
        for y in 0..height {
            for x in 0..width {
                let mut re = [0.0f32; 4];
                let mut im = [0.0f32; 4];
                for (t, w) in g.iter().enumerate() {
                    let sy = mirror_index(y as isize + t as isize - half, height);
                    let p = plane[sy * width + x];
                    re = std::array::from_fn(|c| re[c] + w[0] * p[c]);
                    im = std::array::from_fn(|c| im[c] + w[1] * p[c]);
                }
                v_re[y * width + x] = re;
                v_im[y * width + x] = im;
            }
        }
        for y in 0..height {
            for x in 0..width {
                let mut acc = [0.0f32; 4];
                for (t, w) in h.iter().enumerate() {
                    let sx = mirror_index(x as isize + t as isize - half, width);
                    let i = y * width + sx;
                    acc = std::array::from_fn(|c| acc[c] + w[0] * v_re[i][c] - w[1] * v_im[i][c]);
                }
                let o = y * width + x;
                out[o] = std::array::from_fn(|c| out[o][c] + acc[c]);
            }
        }
    }
    out
}

/// Bokeh Blur of a straight-alpha RGBA8 image (FX-BLUR-BOKEH): gamma(e), the disc approximation of
/// `plan(radius, quality)` in linear light with a mirror border, then the inverse gamma. `gamma_boost`
/// is in -0.99..=2 and `quality` is 1..=10. A radius below `MIN_RADIUS` returns the input unchanged.
pub fn bokeh_blur_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    radius: f32,
    gamma_boost: f32,
    quality: u8,
) -> Result<Vec<u8>, String> {
    if !(1..=MAX_QUALITY).contains(&quality) {
        return Err(format!("quality must be 1-{MAX_QUALITY}, got {quality}"));
    }
    check_separable_args(src, width, height, radius, gamma_boost)?;
    if radius < MIN_RADIUS || width == 0 || height == 0 {
        return Ok(src.to_vec());
    }
    let plan = plan(radius, quality)?;
    Ok(gamma_pipeline(src, 1.0 + gamma_boost, |plane| {
        filter(&plane, width, height, &plan)
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The complex sum of the kernel over its discrete support, `Σ_k G_k · H_k`. The kernel is its real part.
    fn kernel_sum(plan: &Plan) -> (f64, f64) {
        let taps = 2 * plan.half_width + 1;
        let mut total = (0.0, 0.0);
        for term in 0..plan.vertical.len() / taps {
            let fold = |weights: &[[f32; 2]]| {
                weights.iter().fold((0.0, 0.0), |(re, im), w| {
                    (re + f64::from(w[0]), im + f64::from(w[1]))
                })
            };
            let product = cmul(
                fold(&plan.vertical[term * taps..(term + 1) * taps]),
                fold(&plan.horizontal[term * taps..(term + 1) * taps]),
            );
            total = (total.0 + product.0, total.1 + product.1);
        }
        total
    }

    #[test]
    fn fit_error_falls_as_quality_rises() {
        let rates: Vec<(f64, f64)> = (0..usize::from(MAX_QUALITY)).map(rate).collect();
        let errors: Vec<f64> = (1..=rates.len()).map(|q| fit_error(&rates[..q])).collect();
        for pair in errors.windows(2) {
            assert!(pair[1] < pair[0], "{errors:?}");
        }
        assert!(errors[9] < 0.1, "{errors:?}");
    }

    #[test]
    fn the_kernel_sums_to_one_on_its_support() {
        for quality in [1, 3, 10] {
            for radius in [1.0, 2.0, 7.25, 40.0] {
                let plan = plan(radius, quality).unwrap();
                let (re, _) = kernel_sum(&plan);
                assert!((re - 1.0).abs() < 1e-4, "q{quality} r{radius}: {re}");
            }
        }
    }

    #[test]
    fn plan_has_one_tap_run_per_term_and_flattens_both_halves() {
        let plan = plan(3.0, 4).unwrap();
        assert_eq!(plan.half_width, 3);
        assert_eq!(plan.vertical.len(), 4 * 7);
        assert_eq!(plan.horizontal.len(), 4 * 7);
        assert_eq!(plan_values(3.0, 4).unwrap().len(), 4 * 7 * 4);
    }

    #[test]
    fn uniform_image_stays_uniform_and_small_radius_is_the_input() {
        let pixel = [120, 60, 200, 255];
        let src: Vec<u8> = (0..9 * 7).flat_map(|_| pixel).collect();
        for quality in [1, 5, 10] {
            assert_eq!(
                bokeh_blur_rgba8(&src, 9, 7, 3.5, 0.5, quality).unwrap(),
                src
            );
        }
        assert_eq!(bokeh_blur_rgba8(&src, 9, 7, 0.0, 0.5, 3).unwrap(), src);
        assert_eq!(bokeh_blur_rgba8(&src, 9, 7, 0.5, 0.5, 3).unwrap(), src);
    }

    #[test]
    fn a_point_light_spreads_into_a_flat_disc() {
        let (width, height, radius) = (41, 41, 8.0f32);
        let mut src = vec![0u8; width * height * 4];
        for px in src.as_chunks_mut::<4>().0 {
            px[3] = 255;
        }
        let center = (20 * width + 20) * 4;
        src[center..center + 3].copy_from_slice(&[255, 255, 255]);
        let out = bokeh_blur_rgba8(&src, width, height, radius, 0.0, 10).unwrap();
        let value = |x: usize, y: usize| f64::from(out[(y * width + x) * 4]);
        let inside = [(0, 0), (2, 3), (4, 0), (5, 2), (3, 5)];
        let mean: f64 = inside
            .iter()
            .map(|&(dx, dy)| value(20 + dx, 20 + dy))
            .sum::<f64>()
            / inside.len() as f64;
        assert!(mean > 0.0);
        for &(dx, dy) in &inside {
            let v = value(20 + dx, 20 + dy);
            assert!((v - mean).abs() < 0.15 * mean, "{dx},{dy}: {v} vs {mean}");
        }
        assert!(value(20 + 12, 20) < 0.05 * mean);
    }

    #[test]
    fn rejects_invalid_arguments() {
        let src = vec![0u8; 4 * 4];
        assert!(bokeh_blur_rgba8(&src, 2, 2, 1.0, 0.0, 0).is_err());
        assert!(bokeh_blur_rgba8(&src, 2, 2, 1.0, 0.0, 11).is_err());
        assert!(bokeh_blur_rgba8(&src, 2, 2, -1.0, 0.0, 3).is_err());
        assert!(bokeh_blur_rgba8(&src, 2, 2, f32::NAN, 0.0, 3).is_err());
        assert!(bokeh_blur_rgba8(&src, 2, 2, 1.0, -1.0, 3).is_err());
        assert!(bokeh_blur_rgba8(&src[..8], 2, 2, 1.0, 0.0, 3).is_err());
        assert!(plan(0.5, 3).is_err());
    }
}
