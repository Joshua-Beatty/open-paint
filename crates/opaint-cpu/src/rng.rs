//! The shared random generator and seeds of the effects (FX-A-00-05). The per-pixel generator is
//! stateless: a pixel's coordinates and a seed give its first state, and each draw re-hashes it.
//! `packages/effects/src/rng-wgsl.ts` is the WGSL twin and must stay bit-identical.

/// The 32-bit PCG hash: one step of the PCG output function (`state = in * 747796405 + 2891336453`,
/// a variable xorshift-multiply by 277803737, then a final xorshift by 22).
pub const fn pcg_hash(input: u32) -> u32 {
    let state = input.wrapping_mul(747_796_405).wrapping_add(2_891_336_453);
    let word = ((state >> ((state >> 28) + 4)) ^ state).wrapping_mul(277_803_737);
    (word >> 22) ^ word
}

/// The "times 33, xor" combine of two hash values.
pub fn hash_combine(seed: u32, value: u32) -> u32 {
    seed.wrapping_mul(33) ^ value
}

/// The first state of the generator at pixel (`x`, `y`) under `seed`. The hashed coordinates
/// are combined with the seed.
pub fn pixel_state(seed: u32, x: u32, y: u32) -> u32 {
    hash_combine(seed, pcg_hash(pcg_hash(x) ^ y))
}

/// A stateless draw sequence for one pixel. Each draw re-hashes the state and returns the top 24
/// bits as a fraction in `[0, 1)`.
pub struct PixelRng {
    state: u32,
}

impl PixelRng {
    pub fn new(seed: u32, x: u32, y: u32) -> Self {
        Self {
            state: pixel_state(seed, x, y),
        }
    }

    pub fn next_unit(&mut self) -> f32 {
        self.state = pcg_hash(self.state);
        (self.state >> 8) as f32 * (1.0 / 16_777_216.0)
    }
}

/// Add Noise: `userSeed XOR instanceSeed` (FX-NOISE-ADD-03), using all 32 bits of the instance seed.
pub fn add_noise_seed(user: u32, instance: u32) -> u32 {
    user ^ instance
}

/// Crystalize: `userSeed * 1566083941 + instanceSeed` in 32 bits, with the instance's low 8 bits.
pub fn crystalize_seed(user: u32, instance: u32) -> u32 {
    user.wrapping_mul(1_566_083_941)
        .wrapping_add(instance & 0xff)
}

/// Dents: `(userSeed + instanceSeed) mod 256`, with the instance's low 8 bits.
pub fn dents_seed(user: u32, instance: u32) -> u32 {
    user.wrapping_add(instance & 0xff) & 0xff
}

/// Frosted Glass: `userSeed XOR (instanceSeed XOR mapRandom[i])`, with the instance's low 8 bits.
pub fn frost_seed(user: u32, instance: u32, map_random: u32) -> u32 {
    user ^ ((instance & 0xff) ^ map_random)
}

/// One 32-bit random value per Frosted Glass sample map, generated once per effect instance.
pub fn frost_map_randoms(instance: u32, count: usize) -> Vec<u32> {
    (0..count)
        .map(|index| pcg_hash(hash_combine(instance, index as u32)))
        .collect()
}

/// Per-pixel random noise as RGBA8: three draws per pixel for the color channels, each `floor(256 u)`
/// (exact, since draws are multiples of 2^-24), and opaque alpha.
pub fn noise_rgba8(width: usize, height: usize, seed: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(width * height * 4);
    for y in 0..height {
        for x in 0..width {
            let mut rng = PixelRng::new(seed, x as u32, y as u32);
            for _ in 0..3 {
                out.push(((rng.next_unit() * 256.0).floor() as u32).min(255) as u8);
            }
            out.push(255);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcg_hash_is_deterministic_and_spreads_neighbors() {
        assert_eq!(pcg_hash(7), pcg_hash(7));
        assert_ne!(pcg_hash(0), pcg_hash(1));
        let differing = (0..64u32)
            .filter(|&i| (pcg_hash(i) ^ pcg_hash(i + 1)).count_ones() > 6)
            .count();
        assert!(
            differing > 48,
            "only {differing} of 64 neighbors differ in many bits"
        );
    }

    #[test]
    fn draws_lie_in_the_unit_interval_on_the_24_bit_grid() {
        let mut rng = PixelRng::new(42, 3, 5);
        let mut sum = 0.0f64;
        for _ in 0..20_000 {
            let u = rng.next_unit();
            assert!((0.0..1.0).contains(&u));
            assert_eq!((u * 16_777_216.0).fract(), 0.0);
            sum += f64::from(u);
        }
        let mean = sum / 20_000.0;
        assert!((mean - 0.5).abs() < 0.01, "mean {mean}");
    }

    #[test]
    fn pixel_state_depends_on_the_seed_and_both_coordinates() {
        let base = pixel_state(9, 10, 20);
        assert_eq!(base, pixel_state(9, 10, 20));
        assert_ne!(base, pixel_state(10, 10, 20));
        assert_ne!(base, pixel_state(9, 11, 20));
        assert_ne!(base, pixel_state(9, 10, 21));
        assert_ne!(pixel_state(9, 10, 20), pixel_state(9, 20, 10));
    }

    #[test]
    fn seed_combiners_follow_the_spec_formulas() {
        assert_eq!(add_noise_seed(0b1010, 0b0110), 0b1100);
        assert_eq!(
            crystalize_seed(1, 0x1_05),
            1_566_083_941u32.wrapping_add(0x05)
        );
        assert_eq!(crystalize_seed(2, 0), 3_132_167_882);
        assert_eq!(dents_seed(200, 0x1ff), 199);
        assert_eq!(frost_seed(7, 0x105, 0xf0), 7 ^ (0x05 ^ 0xf0));
    }

    #[test]
    fn frost_map_randoms_are_distinct_per_instance_and_index() {
        let randoms = frost_map_randoms(0xdead_beef, 8);
        assert_eq!(randoms.len(), 8);
        assert_eq!(randoms, frost_map_randoms(0xdead_beef, 8));
        for (i, value) in randoms.iter().enumerate() {
            assert!(!randoms[i + 1..].contains(value));
        }
        assert_ne!(randoms, frost_map_randoms(0xdead_beee, 8));
    }

    #[test]
    fn noise_is_opaque_repeatable_and_seed_dependent() {
        let a = noise_rgba8(5, 4, 0);
        assert_eq!(a.len(), 5 * 4 * 4);
        assert!(a.as_chunks::<4>().0.iter().all(|px| px[3] == 255));
        assert_eq!(a, noise_rgba8(5, 4, 0));
        assert_ne!(a, noise_rgba8(5, 4, 1));
        assert!(a.iter().any(|&v| v > 200) && a.iter().any(|&v| v < 55));
    }
}
