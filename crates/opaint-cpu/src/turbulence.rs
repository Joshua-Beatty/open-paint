//! Turbulence (FX-RENDER-TURB-01): the SVG `feTurbulence` algorithm (Perlin turbulence or fractal sum,
//! with stitched tiles), repeated across the canvas and composited with a blend mode. The tables and
//! the base frequencies come from here, so the WGSL twin reads the same values. The noise itself runs
//! in f32 in the same order as the WGSL, so the two agree to within one 8-bit step.

use crate::mix::{MixMode, mix_rgba8};

const BSIZE: usize = 256;
const BM: i32 = 255;
const PERLIN_N: i32 = 4096;
/// The lattice has `BSIZE + 2` entries, repeated once so that `index + 1` never wraps.
pub const LATTICE_LEN: usize = BSIZE + BSIZE + 2;
const RAND_M: i64 = 2_147_483_647;
const RAND_A: i64 = 16_807;
const RAND_Q: i64 = 127_773;
const RAND_R: i64 = 2_836;

/// The SVG reference generator (Park-Miller minimal standard).
fn random(seed: i64) -> i64 {
    let mut result = RAND_A * (seed % RAND_Q) - RAND_R * (seed / RAND_Q);
    if result <= 0 {
        result += RAND_M;
    }
    result
}

fn setup_seed(seed: i64) -> i64 {
    let mut s = seed;
    if s <= 0 {
        s = -(s % (RAND_M - 1)) + 1;
    }
    if s > RAND_M - 1 {
        s = RAND_M - 1;
    }
    s
}

/// The index of gradient `(channel, index, component)` in the flat table.
pub fn gradient_index(channel: usize, index: usize, component: usize) -> usize {
    (channel * LATTICE_LEN + index) * 2 + component
}

/// The lattice selector and the four channels' unit gradients, built from `seed` as in the SVG
/// reference's `init`. The gradient components are rounded to f32 for the WGSL twin.
fn build_tables(seed: u32) -> (Vec<u32>, Vec<f32>) {
    let mut state = setup_seed(i64::from(seed));
    let mut lattice = vec![0usize; LATTICE_LEN];
    let mut gradient = vec![0f64; 4 * LATTICE_LEN * 2];
    for channel in 0..4 {
        for (i, slot) in lattice.iter_mut().enumerate().take(BSIZE) {
            *slot = i;
            let mut g = [0f64; 2];
            for component in &mut g {
                state = random(state);
                *component = ((state % (BSIZE as i64 * 2)) - BSIZE as i64) as f64 / BSIZE as f64;
            }
            let length = (g[0] * g[0] + g[1] * g[1]).sqrt();
            if length > 0.0 {
                g[0] /= length;
                g[1] /= length;
            }
            gradient[gradient_index(channel, i, 0)] = g[0];
            gradient[gradient_index(channel, i, 1)] = g[1];
        }
    }
    for i in (1..BSIZE).rev() {
        state = random(state);
        let j = (state % BSIZE as i64) as usize;
        lattice.swap(i, j);
    }
    for i in 0..BSIZE + 2 {
        lattice[BSIZE + i] = lattice[i];
        for channel in 0..4 {
            for component in 0..2 {
                gradient[gradient_index(channel, BSIZE + i, component)] =
                    gradient[gradient_index(channel, i, component)];
            }
        }
    }
    (
        lattice.iter().map(|&i| i as u32).collect(),
        gradient.iter().map(|&g| g as f32).collect(),
    )
}

/// The lattice selector table (514 entries) for a seed, for the WGSL storage buffer.
pub fn turbulence_lattice(seed: u32) -> Vec<u32> {
    build_tables(seed).0
}

/// The gradient table (4 channels x 514 entries x 2 components) for a seed, for the WGSL storage
/// buffer. Index it with `gradient_index`.
pub fn turbulence_gradients(seed: u32) -> Vec<f32> {
    build_tables(seed).1
}

/// The base frequencies and stitch values of a tile of `tile` pixels at `period` (FX-RENDER-TURB-01):
/// `[freq_x, freq_y, width, wrap_x, height, wrap_y]`. The frequencies are snapped so the tile holds a
/// whole number of cycles, which keeps the tile seamless when it repeats.
pub fn turbulence_plan(period: f32, tile: u32) -> Result<[f32; 6], String> {
    if !(0.1..=1024.0).contains(&period) {
        return Err(format!("period must be 0.1..=1024, got {period}"));
    }
    if !(1..=4096).contains(&tile) {
        return Err(format!("tile must be 1..=4096, got {tile}"));
    }
    let size = f64::from(tile);
    let base = 1.0 / f64::from(period);
    let snapped = |freq: f64| {
        let lo = (size * freq).floor() / size;
        let hi = (size * freq).ceil() / size;
        if freq / lo < hi / freq { lo } else { hi }
    };
    let (fx, fy) = (snapped(base), snapped(base));
    let width = (size * fx + 0.5) as i32;
    let height = (size * fy + 0.5) as i32;
    Ok([
        fx as f32,
        fy as f32,
        width as f32,
        (PERLIN_N + width) as f32,
        height as f32,
        (PERLIN_N + height) as f32,
    ])
}

/// The per-octave stitch state of the SVG reference.
#[derive(Clone, Copy)]
struct Stitch {
    width: i32,
    wrap_x: i32,
    height: i32,
    wrap_y: i32,
}

fn s_curve(t: f32) -> f32 {
    t * t * (3.0 - 2.0 * t)
}

fn lerp(t: f32, a: f32, b: f32) -> f32 {
    a + t * (b - a)
}

/// The SVG reference `noise2` for one channel at point `(vx, vy)`, with stitching.
fn noise2(lattice: &[u32], gradient: &[f32], channel: usize, vx: f32, vy: f32, st: Stitch) -> f32 {
    let tx = vx + PERLIN_N as f32;
    let ty = vy + PERLIN_N as f32;
    let mut bx0 = tx as i32;
    let mut bx1 = bx0 + 1;
    let rx0 = tx - bx0 as f32;
    let rx1 = rx0 - 1.0;
    let mut by0 = ty as i32;
    let mut by1 = by0 + 1;
    let ry0 = ty - by0 as f32;
    let ry1 = ry0 - 1.0;
    if bx0 >= st.wrap_x {
        bx0 -= st.width;
    }
    if bx1 >= st.wrap_x {
        bx1 -= st.width;
    }
    if by0 >= st.wrap_y {
        by0 -= st.height;
    }
    if by1 >= st.wrap_y {
        by1 -= st.height;
    }
    let bx0 = (bx0 & BM) as usize;
    let bx1 = (bx1 & BM) as usize;
    let by0 = (by0 & BM) as usize;
    let by1 = (by1 & BM) as usize;
    let i = lattice[bx0] as usize;
    let j = lattice[bx1] as usize;
    let b00 = lattice[i + by0] as usize;
    let b10 = lattice[j + by0] as usize;
    let b01 = lattice[i + by1] as usize;
    let b11 = lattice[j + by1] as usize;
    let sx = s_curve(rx0);
    let sy = s_curve(ry0);
    let q = |b: usize| {
        (
            gradient[gradient_index(channel, b, 0)],
            gradient[gradient_index(channel, b, 1)],
        )
    };
    let (q0, q1) = q(b00);
    let u = rx0 * q0 + ry0 * q1;
    let (q0, q1) = q(b10);
    let v = rx1 * q0 + ry0 * q1;
    let a = lerp(sx, u, v);
    let (q0, q1) = q(b01);
    let u = rx0 * q0 + ry1 * q1;
    let (q0, q1) = q(b11);
    let v = rx1 * q0 + ry1 * q1;
    let b = lerp(sx, u, v);
    lerp(sy, a, b)
}

/// The octave sum of one channel at a pixel of the tile (FX-RENDER-TURB-01). `fractal` selects the
/// fractal sum (signed noise) over turbulence (absolute noise).
fn octave_sum(
    tables: &(Vec<u32>, Vec<f32>),
    channel: usize,
    point: (f32, f32),
    plan: &[f32; 6],
    octaves: u32,
    fractal: bool,
) -> f32 {
    let (lattice, gradient) = tables;
    let mut vx = point.0 * plan[0];
    let mut vy = point.1 * plan[1];
    let mut st = Stitch {
        width: plan[2] as i32,
        wrap_x: plan[3] as i32,
        height: plan[4] as i32,
        wrap_y: plan[5] as i32,
    };
    let mut sum = 0.0;
    let mut ratio = 1.0;
    for _ in 0..octaves {
        let n = noise2(lattice, gradient, channel, vx, vy, st);
        sum += if fractal { n / ratio } else { n.abs() / ratio };
        vx *= 2.0;
        vy *= 2.0;
        ratio *= 2.0;
        st = Stitch {
            width: st.width * 2,
            wrap_x: 2 * st.wrap_x - PERLIN_N,
            height: st.height * 2,
            wrap_y: 2 * st.wrap_y - PERLIN_N,
        };
    }
    sum
}

/// Parameters of Turbulence (FX-RENDER-TURB-01), as the host computes them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TurbulenceParams {
    /// The region's top-left corner in document pixels.
    pub origin: (u32, u32),
    /// Octaves, 1..=15.
    pub octaves: u32,
    /// Period in pixels, 0.1..=1024. The base frequency is 1 / period on both axes.
    pub period: f32,
    /// Tile size in pixels, 1..=4096.
    pub tile: u32,
    /// Fractal sum (true) or Turbulence (false).
    pub fractal: bool,
    /// The effective seed, 0..=255 (FX-A-00-05).
    pub seed: u32,
    pub mode: MixMode,
}

impl TurbulenceParams {
    /// Reads the parameters from the flat array the host sends: origin x and y, octaves, period,
    /// tile size, fractal flag (1 or 0), seed, then the mode.
    pub fn from_plan(plan: &[f32]) -> Result<Self, String> {
        let [ox, oy, octaves, period, tile, fractal, seed, mode] = <[f32; 8]>::try_from(plan)
            .map_err(|_| format!("turbulence plan needs 8 values, got {}", plan.len()))?;
        if !(1.0..=15.0).contains(&octaves) || octaves.fract() != 0.0 {
            return Err(format!("octaves must be an integer 1..=15, got {octaves}"));
        }
        if !(1.0..=4096.0).contains(&tile) || tile.fract() != 0.0 {
            return Err(format!("tile must be an integer 1..=4096, got {tile}"));
        }
        if !(0.0..=255.0).contains(&seed) || seed.fract() != 0.0 {
            return Err(format!("seed must be an integer 0..=255, got {seed}"));
        }
        if !(0.0..=45.0).contains(&mode) || mode.fract() != 0.0 {
            return Err(format!("mix mode must be an integer 0..=45, got {mode}"));
        }
        let mode = MixMode::try_from(mode as u8).map_err(|code| format!("mix mode {code}"))?;
        Ok(Self {
            origin: (ox as u32, oy as u32),
            octaves: octaves as u32,
            period,
            tile: tile as u32,
            fractal: fractal != 0.0,
            seed: seed as u32,
            mode,
        })
    }
}

/// The generated turbulence of a region, straight RGBA on 0..=1 (FX-RENDER-TURB-01). The tile repeats
/// with period `tile` in document pixels.
pub fn turbulence_image(
    width: usize,
    height: usize,
    params: &TurbulenceParams,
) -> Result<Vec<[f32; 4]>, String> {
    let plan = turbulence_plan(params.period, params.tile)?;
    let tables = build_tables(params.seed);
    let tile = params.tile;
    let mut out = Vec::with_capacity(width * height);
    for y in 0..height {
        let py = (params.origin.1 + y as u32) % tile;
        for x in 0..width {
            let px = (params.origin.0 + x as u32) % tile;
            let point = (px as f32, py as f32);
            let mut color = [0.0f32; 4];
            for (channel, value) in color.iter_mut().enumerate() {
                let sum = octave_sum(
                    &tables,
                    channel,
                    point,
                    &plan,
                    params.octaves,
                    params.fractal,
                );
                let v = if params.fractal {
                    (sum + 1.0) / 2.0
                } else {
                    sum
                };
                *value = v.clamp(0.0, 1.0);
            }
            out.push(color);
        }
    }
    Ok(out)
}

/// Turbulence (FX-RENDER-TURB-01) composited onto `src` (straight RGBA8) with the blend mode.
pub fn turbulence_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    params: &TurbulenceParams,
) -> Result<Vec<u8>, String> {
    let image = turbulence_image(width, height, params)?;
    mix_rgba8(src, &image, width, params.mode)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(fractal: bool) -> TurbulenceParams {
        TurbulenceParams {
            origin: (0, 0),
            octaves: 4,
            period: 16.0,
            tile: 64,
            fractal,
            seed: 1,
            mode: MixMode::Over,
        }
    }

    #[test]
    fn the_generator_matches_the_park_miller_sequence() {
        // 16807 is the first draw from seed 1, and the sequence stays in range.
        assert_eq!(random(1), 16_807);
        assert_eq!(random(16_807), 282_475_249);
        assert_eq!(setup_seed(0), 1);
        assert_eq!(setup_seed(i64::MAX), RAND_M - 1);
    }

    #[test]
    fn the_lattice_is_a_permutation_repeated_once() {
        let lattice = turbulence_lattice(7);
        assert_eq!(lattice.len(), LATTICE_LEN);
        let mut seen = [false; BSIZE];
        for &v in &lattice[..BSIZE] {
            assert!(!seen[v as usize], "{v} repeats");
            seen[v as usize] = true;
        }
        assert_eq!(lattice[BSIZE], lattice[0]);
        assert_eq!(lattice[BSIZE + 1], lattice[1]);
    }

    #[test]
    fn the_gradients_are_unit_length_and_repeated() {
        let gradient = turbulence_gradients(7);
        assert_eq!(gradient.len(), 4 * LATTICE_LEN * 2);
        for channel in 0..4 {
            for i in 0..BSIZE {
                let (x, y) = (
                    gradient[gradient_index(channel, i, 0)],
                    gradient[gradient_index(channel, i, 1)],
                );
                assert!(((x * x + y * y).sqrt() - 1.0).abs() < 1e-5);
            }
            assert_eq!(
                gradient[gradient_index(channel, BSIZE, 0)],
                gradient[gradient_index(channel, 0, 0)]
            );
        }
    }

    #[test]
    fn plan_snaps_the_frequency_to_whole_cycles() {
        // Period 16 over a 64 px tile is exactly 4 cycles, so the frequency is 1/16 unchanged.
        let plan = turbulence_plan(16.0, 64).expect("valid");
        assert_eq!(plan[0], 0.0625);
        assert_eq!(plan[2], 4.0);
        assert_eq!(plan[3], 4100.0);
        // Period 10 over 64 px is 6.4 cycles, which snaps to 6 or 7 (the nearer ratio).
        let snapped = turbulence_plan(10.0, 64).expect("valid")[0] * 64.0;
        assert!((snapped - snapped.round()).abs() < 1e-4);
        assert!(turbulence_plan(0.0, 64).is_err());
        assert!(turbulence_plan(16.0, 0).is_err());
    }

    #[test]
    fn fractal_sum_and_turbulence_stay_in_range() {
        for fractal in [true, false] {
            for px in turbulence_image(32, 32, &params(fractal)).expect("valid") {
                for v in px {
                    assert!((0.0..=1.0).contains(&v), "{px:?}");
                }
            }
        }
    }

    #[test]
    fn the_tile_repeats_across_the_canvas() {
        // A pixel one tile to the right is the same pixel of the tile.
        let base = params(false);
        let whole = turbulence_image(64, 8, &base).expect("valid");
        let mut shifted = base;
        shifted.origin = (64, 0);
        let next = turbulence_image(4, 8, &shifted).expect("valid");
        for y in 0..8 {
            for x in 0..4 {
                assert_eq!(next[y * 4 + x], whole[y * 64 + x]);
            }
        }
    }

    #[test]
    fn stitching_makes_the_tile_edges_meet() {
        // At one tile's distance the stitched lattice wraps back to the first cell in every octave,
        // so the point at the tile's far edge takes the value of the point at 0 (no seam).
        let tables = build_tables(1);
        let plan = turbulence_plan(16.0, 64).expect("valid");
        for channel in 0..4 {
            for y in (0..64).step_by(7) {
                let p = (0.0, y as f32);
                let far = (64.0, y as f32);
                let base = octave_sum(&tables, channel, p, &plan, 4, true);
                assert!((base - octave_sum(&tables, channel, far, &plan, 4, true)).abs() < 1e-6);
            }
            for x in (0..64).step_by(5) {
                let p = (x as f32, 0.0);
                let far = (x as f32, 64.0);
                let base = octave_sum(&tables, channel, p, &plan, 4, true);
                assert!((base - octave_sum(&tables, channel, far, &plan, 4, true)).abs() < 1e-6);
            }
        }
    }

    #[test]
    fn plan_round_trips_and_rejects_bad_values() {
        let plan = [0.0, 0.0, 4.0, 16.0, 64.0, 1.0, 1.0, 0.0];
        let read = TurbulenceParams::from_plan(&plan).expect("valid");
        assert!(read.fractal);
        assert_eq!(read.tile, 64);
        assert_eq!(read.octaves, 4);
        assert!(TurbulenceParams::from_plan(&plan[..7]).is_err());
        let mut bad = plan;
        bad[2] = 16.5;
        assert!(TurbulenceParams::from_plan(&bad).is_err());
    }

    #[test]
    fn turbulence_composites_with_the_blend_mode() {
        let mut p = params(false);
        p.mode = MixMode::Overwrite;
        let dst = vec![9u8; 16 * 16 * 4];
        let out = turbulence_rgba8(&dst, 16, 16, &p).expect("sizes match");
        assert_ne!(out, dst);
    }
}
