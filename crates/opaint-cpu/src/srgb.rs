//! sRGB transfer functions (IEC 61966-2-1) on values in 0..=1, shared by the linear-light kernels
//! (Gaussian Blur and resampling).

/// Decodes an sRGB-encoded value to linear light.
pub fn to_linear(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

/// Encodes a linear-light value as sRGB.
pub fn to_srgb(v: f32) -> f32 {
    if v <= 0.0031308 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transfer_functions_invert_each_other() {
        for step in 0..=255 {
            let v = step as f32 / 255.0;
            assert!((to_srgb(to_linear(v)) - v).abs() < 1e-5, "{v}");
        }
    }

    #[test]
    fn linear_half_encodes_to_188_in_8_bits() {
        assert_eq!((to_srgb(0.5) * 255.0).round(), 188.0);
    }
}
