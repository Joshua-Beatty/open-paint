//! Clouds (FX-RENDER-CLOUDS-01): improved Perlin noise summed over octaves, mapped between two
//! colors and composited with a blend mode (`mix.rs`). The WGSL twin in `packages/effects` reads the
//! permutation table from `cloud_permutation`, so both backends hash the same lattice.

use crate::mix::{MixMode, mix_rgba8};

/// The octave loop runs while the octave weight is above this and the frequency divisor is positive
/// (FX-RENDER-CLOUDS-01), and never more than this many times.
const CLOUD_OCTAVES: usize = 12;
const CLOUD_MIN_MULT: f32 = 0.03;

/// Ken Perlin's reference permutation table (FX-RENDER-CLOUDS-01).
pub const PERMUTATION: [u8; 256] = [
    151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140, 36, 103, 30, 69,
    142, 8, 99, 37, 240, 21, 10, 23, 190, 6, 148, 247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219,
    203, 117, 35, 11, 32, 57, 177, 33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175,
    74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122, 60, 211, 133, 230,
    220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25, 63, 161, 1, 216, 80, 73, 209, 76,
    132, 187, 208, 89, 18, 169, 200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173,
    186, 3, 64, 52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212, 207, 206,
    59, 227, 47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170, 213, 119, 248, 152, 2, 44, 154, 163,
    70, 221, 153, 101, 155, 167, 43, 172, 9, 129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232,
    178, 185, 112, 104, 218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191, 179, 162,
    241, 81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157, 184, 84, 204,
    176, 115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205, 93, 222, 114, 67, 29, 24, 72, 243, 141,
    128, 195, 78, 66, 215, 61, 156, 180,
];

/// The permutation table as `u32` values, for the WGSL storage buffer.
pub fn cloud_permutation() -> Vec<u32> {
    PERMUTATION.iter().map(|&p| u32::from(p)).collect()
}

/// Parameters of Clouds (FX-RENDER-CLOUDS-01), as the host computes them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CloudsParams {
    /// The region's top-left corner in document pixels.
    pub origin: (u32, u32),
    /// The document size in pixels.
    pub document: (u32, u32),
    /// Scale, 2..=1000: the frequency divisor of the first octave.
    pub scale: u32,
    /// Roughness, 0..=1: the weight ratio between octaves.
    pub roughness: f32,
    /// The effective seed, 0..=255 (FX-A-00-05).
    pub seed: u32,
    /// Color 1 and Color 2, straight RGBA on 0..=1.
    pub color1: [f32; 4],
    pub color2: [f32; 4],
    pub mode: MixMode,
}

impl CloudsParams {
    /// Reads the parameters from the flat array the host sends: origin x and y, document width and
    /// height, scale, roughness, seed, mode, then Color 1 and Color 2 as RGBA.
    pub fn from_plan(plan: &[f32]) -> Result<Self, String> {
        let [
            ox,
            oy,
            dw,
            dh,
            scale,
            roughness,
            seed,
            mode,
            c1r,
            c1g,
            c1b,
            c1a,
            c2r,
            c2g,
            c2b,
            c2a,
        ] = <[f32; 16]>::try_from(plan)
            .map_err(|_| format!("clouds plan needs 16 values, got {}", plan.len()))?;
        if !(2.0..=1000.0).contains(&scale) || scale.fract() != 0.0 {
            return Err(format!("scale must be an integer 2..=1000, got {scale}"));
        }
        if !(0.0..=1.0).contains(&roughness) {
            return Err(format!("roughness must be 0..=1, got {roughness}"));
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
            document: (dw as u32, dh as u32),
            scale: scale as u32,
            roughness,
            seed: seed as u32,
            color1: [c1r, c1g, c1b, c1a],
            color2: [c2r, c2g, c2b, c2a],
            mode,
        })
    }
}

/// `perm[i & 255]`.
fn perm(i: i32) -> i32 {
    i32::from(PERMUTATION[(i & 255) as usize])
}

/// The lattice hash of corner `(ix, iy)` for a seed, from the permutation table.
fn hash(ix: i32, iy: i32, seed: i32) -> i32 {
    perm((perm((ix ^ seed) & 255) + iy) & 255)
}

/// The 16-direction gradient of hash `h` dotted with `(x, y)` (FX-RENDER-CLOUDS-01).
fn grad(h: i32, x: f32, y: f32) -> f32 {
    let h4 = h & 15;
    let u = if h4 < 8 { x } else { y };
    let v = if h4 < 4 {
        y
    } else if h4 == 12 || h4 == 14 {
        x
    } else {
        0.0
    };
    let a = if h & 1 != 0 { -u } else { u };
    let b = if h & 2 != 0 { -v } else { v };
    a + b
}

fn fade(t: f32) -> f32 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

fn lerp(t: f32, a: f32, b: f32) -> f32 {
    a + t * (b - a)
}

/// Improved Perlin noise of one cell corner set, at fraction `(fx, fy)` in cell `(ix, iy)`.
fn noise2(ix: i32, iy: i32, fx: f32, fy: f32, seed: i32) -> f32 {
    let u = fade(fx);
    let v = fade(fy);
    let g00 = grad(hash(ix, iy, seed), fx, fy);
    let g10 = grad(hash(ix + 1, iy, seed), fx - 1.0, fy);
    let g01 = grad(hash(ix, iy + 1, seed), fx, fy - 1.0);
    let g11 = grad(hash(ix + 1, iy + 1, seed), fx - 1.0, fy - 1.0);
    lerp(v, lerp(u, g00, g10), lerp(u, g01, g11))
}

/// The summed noise at the doubled, centered coordinate `(dx, dy)` (FX-RENDER-CLOUDS-01). The
/// frequency divisor halves each octave, so the value of `d / div` is split into its integer cell
/// and its fraction exactly: `65536 + d / div` has the same cell mod 256 and the same fraction.
fn cloud_value(dx: i32, dy: i32, scale: i32, roughness: f32, seed: i32) -> f32 {
    let mut value = 0.0;
    let mut mult = 1.0;
    let mut div = scale;
    for i in 0..CLOUD_OCTAVES {
        if !(mult > CLOUD_MIN_MULT && div > 0) {
            break;
        }
        let (qx, rx) = (dx.div_euclid(div), dx.rem_euclid(div));
        let (qy, ry) = (dy.div_euclid(div), dy.rem_euclid(div));
        let fx = rx as f32 / div as f32;
        let fy = ry as f32 / div as f32;
        let octave_seed = (seed + i as i32) & 255;
        value += noise2(qx & 255, qy & 255, fx, fy, octave_seed) * mult;
        div >>= 1;
        mult *= roughness;
    }
    value
}

/// The generated clouds of a region, straight RGBA on 0..=1 (FX-RENDER-CLOUDS-01 steps 1-5).
pub fn clouds_image(width: usize, height: usize, params: &CloudsParams) -> Vec<[f32; 4]> {
    let (doc_w, doc_h) = (params.document.0 as i32, params.document.1 as i32);
    let seed = params.seed as i32;
    let mut out = Vec::with_capacity(width * height);
    for y in 0..height {
        let dy = 2 * (params.origin.1 as i32 + y as i32) - doc_h;
        for x in 0..width {
            let dx = 2 * (params.origin.0 as i32 + x as i32) - doc_w;
            let value = cloud_value(dx, dy, params.scale as i32, params.roughness, seed);
            let t = ((value + 1.0) / 2.0).clamp(0.0, 1.0);
            let (c1, c2) = (params.color1, params.color2);
            out.push([
                c1[0] + (c2[0] - c1[0]) * t,
                c1[1] + (c2[1] - c1[1]) * t,
                c1[2] + (c2[2] - c1[2]) * t,
                c1[3] + (c2[3] - c1[3]) * t,
            ]);
        }
    }
    out
}

/// Clouds (FX-RENDER-CLOUDS-01) composited onto `src` (straight RGBA8) with the blend mode.
pub fn clouds_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    params: &CloudsParams,
) -> Result<Vec<u8>, String> {
    let image = clouds_image(width, height, params);
    mix_rgba8(src, &image, width, params.mode)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(scale: u32, roughness: f32, seed: u32) -> CloudsParams {
        CloudsParams {
            origin: (0, 0),
            document: (32, 24),
            scale,
            roughness,
            seed,
            color1: [0.0, 0.0, 0.0, 1.0],
            color2: [1.0, 1.0, 1.0, 1.0],
            mode: MixMode::Over,
        }
    }

    #[test]
    fn permutation_is_a_permutation_of_bytes() {
        let mut seen = [false; 256];
        for &p in &PERMUTATION {
            assert!(!seen[usize::from(p)], "{p} repeats");
            seen[usize::from(p)] = true;
        }
        assert!(seen.iter().all(|&s| s));
        assert_eq!(PERMUTATION[0], 151);
        assert_eq!(PERMUTATION[255], 180);
    }

    #[test]
    fn gradients_follow_the_sixteen_direction_hash() {
        // h = 0: u = x and v = y (h4 < 4), both signs positive.
        assert_eq!(grad(0, 0.25, 0.5), 0.75);
        // h = 1: the first sign bit negates u, leaving -x + y.
        assert_eq!(grad(1, 0.25, 0.5), 0.25);
        // h = 8: u = y (h4 >= 8) and v = 0.
        assert_eq!(grad(8, 0.25, 0.5), 0.5);
        // h = 12: u = y and v = x.
        assert_eq!(grad(12, 0.25, 0.5), 0.75);
    }

    #[test]
    fn noise_is_zero_on_lattice_points() {
        for ix in 0..8 {
            for iy in 0..8 {
                assert_eq!(noise2(ix, iy, 0.0, 0.0, 3), 0.0);
            }
        }
    }

    #[test]
    fn clouds_stay_between_the_two_colors() {
        let p = params(40, 0.6, 9);
        for px in clouds_image(32, 24, &p) {
            for c in 0..3 {
                assert!((-1e-6..=1.0 + 1e-6).contains(&px[c]), "{px:?}");
            }
            assert_eq!(px[3], 1.0);
        }
    }

    #[test]
    fn clouds_are_deterministic_and_seed_dependent() {
        let a = clouds_image(32, 24, &params(40, 0.6, 9));
        let b = clouds_image(32, 24, &params(40, 0.6, 9));
        let c = clouds_image(32, 24, &params(40, 0.6, 10));
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn region_pixels_match_the_document_pixels() {
        // A region at (5, 7) of a 32x24 document is the same pixels as the whole image's window.
        let whole = clouds_image(32, 24, &params(40, 0.6, 9));
        let mut region = params(40, 0.6, 9);
        region.origin = (5, 7);
        let window = clouds_image(4, 3, &region);
        for y in 0..3 {
            for x in 0..4 {
                assert_eq!(window[y * 4 + x], whole[(y + 7) * 32 + x + 5]);
            }
        }
    }

    #[test]
    fn zero_roughness_is_a_single_octave() {
        // With roughness 0 the second octave's weight is 0, so the value equals the first octave.
        let (dx, dy): (i32, i32) = (2 * 3 - 32, 2 * 4 - 24);
        let first = noise2(
            dx.div_euclid(40) & 255,
            dy.div_euclid(40) & 255,
            dx.rem_euclid(40) as f32 / 40.0,
            dy.rem_euclid(40) as f32 / 40.0,
            2,
        );
        assert_eq!(cloud_value(dx, dy, 40, 0.0, 2), first);
    }

    #[test]
    fn plan_round_trips_and_rejects_bad_values() {
        let plan = [
            0.0, 0.0, 32.0, 24.0, 40.0, 0.5, 9.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0,
        ];
        let read = CloudsParams::from_plan(&plan).expect("valid plan");
        assert_eq!(read.scale, 40);
        assert_eq!(read.seed, 9);
        assert_eq!(read.mode, MixMode::Over);
        assert!(CloudsParams::from_plan(&plan[..15]).is_err());
        let mut bad = plan;
        bad[4] = 1.0;
        assert!(CloudsParams::from_plan(&bad).is_err());
        let mut bad_mode = plan;
        bad_mode[7] = 46.0;
        assert!(CloudsParams::from_plan(&bad_mode).is_err());
    }

    #[test]
    fn clouds_composite_with_the_blend_mode() {
        let mut p = params(40, 0.5, 4);
        p.mode = MixMode::Overwrite;
        let dst = vec![200u8; 32 * 24 * 4];
        let out = clouds_rgba8(&dst, 32, 24, &p).expect("sizes match");
        // Overwrite replaces the layer with the clouds, so no destination value survives.
        assert_ne!(out, dst);
        assert!(out.as_chunks::<4>().0.iter().all(|px| px[3] == 255));
    }
}
