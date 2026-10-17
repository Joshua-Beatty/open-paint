//! DirectDraw Surface reader (FMT-REG-02 row 7, open only). It decodes the top mip level of the first
//! array element, and the first slice of a volume or cube map, to straight RGBA8. Block-compressed
//! formats (BC1 to BC7) go through `texture2ddecoder`. Uncompressed formats are read through their
//! channel bit masks. DDS has no save path, so nothing here writes a file.

use texture2ddecoder::{
    decode_bc1a, decode_bc2, decode_bc3, decode_bc4, decode_bc5, decode_bc6, decode_bc7,
};

/// A decoded DDS: straight RGBA8, top row first.
#[derive(Debug)]
pub struct Decoded {
    pub width: usize,
    pub height: usize,
    pub rgba: Vec<u8>,
}

const MAGIC: &[u8; 4] = b"DDS ";
const HEADER_LEN: usize = 128;
const DX10_LEN: usize = 20;

const DDPF_ALPHAPIXELS: u32 = 0x1;
const DDPF_ALPHA: u32 = 0x2;
const DDPF_FOURCC: u32 = 0x4;
const DDPF_RGB: u32 = 0x40;
const DDPF_LUMINANCE: u32 = 0x2_0000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Block {
    Bc1,
    Bc2,
    Bc3,
    Bc4,
    Bc5,
    Bc6Unsigned,
    Bc6Signed,
    Bc7,
}

/// The channel masks of an uncompressed format, least significant byte first. A zero mask means the
/// channel is absent: color is zero and alpha is opaque. `gray` copies the red channel to green and blue.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Masks {
    bytes: usize,
    channels: [u32; 4],
    gray: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Layout {
    Block(Block),
    Masks(Masks),
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

fn block_of_fourcc(fourcc: &[u8]) -> Result<Block, String> {
    match fourcc {
        b"DXT1" => Ok(Block::Bc1),
        b"DXT2" | b"DXT3" => Ok(Block::Bc2),
        b"DXT4" | b"DXT5" => Ok(Block::Bc3),
        b"ATI1" | b"BC4U" => Ok(Block::Bc4),
        b"ATI2" | b"BC5U" => Ok(Block::Bc5),
        _ => Err(format!(
            "unsupported DDS format {}",
            String::from_utf8_lossy(fourcc)
        )),
    }
}

fn layout_of_dxgi(format: u32) -> Result<Layout, String> {
    let rgba = Masks {
        bytes: 4,
        channels: [0xFF, 0xFF00, 0xFF_0000, 0xFF00_0000],
        gray: false,
    };
    let bgra = Masks {
        channels: [0xFF_0000, 0xFF00, 0xFF, 0xFF00_0000],
        ..rgba
    };
    let block = |block| Ok(Layout::Block(block));
    match format {
        28 | 29 => Ok(Layout::Masks(rgba)),
        87 | 91 => Ok(Layout::Masks(bgra)),
        88 | 93 => Ok(Layout::Masks(Masks {
            channels: [0xFF_0000, 0xFF00, 0xFF, 0],
            ..rgba
        })),
        61 => Ok(Layout::Masks(Masks {
            bytes: 1,
            channels: [0xFF, 0, 0, 0],
            gray: true,
        })),
        65 => Ok(Layout::Masks(Masks {
            bytes: 1,
            channels: [0, 0, 0, 0xFF],
            gray: false,
        })),
        71 | 72 => block(Block::Bc1),
        74 | 75 => block(Block::Bc2),
        77 | 78 => block(Block::Bc3),
        80 => block(Block::Bc4),
        83 => block(Block::Bc5),
        95 => block(Block::Bc6Unsigned),
        96 => block(Block::Bc6Signed),
        98 | 99 => block(Block::Bc7),
        _ => Err(format!("unsupported DXGI format {format}")),
    }
}

/// The bytes per pixel, the block size, or the mask layout of a legacy (no DX10 header) pixel format.
fn layout_of_pixel_format(flags: u32, bit_count: u32, masks: [u32; 4]) -> Result<Layout, String> {
    let bytes = match bit_count {
        8 | 16 | 24 | 32 => (bit_count / 8) as usize,
        _ => return Err(format!("unsupported DDS bit count {bit_count}")),
    };
    if flags & DDPF_LUMINANCE != 0 {
        return Ok(Layout::Masks(Masks {
            bytes,
            channels: [masks[0], 0, 0, masks[3]],
            gray: true,
        }));
    }
    if flags & DDPF_ALPHA != 0 && flags & DDPF_RGB == 0 {
        return Ok(Layout::Masks(Masks {
            bytes,
            channels: [0, 0, 0, masks[3]],
            gray: false,
        }));
    }
    if flags & DDPF_RGB == 0 {
        return Err("unsupported DDS pixel format".into());
    }
    let alpha = if flags & DDPF_ALPHAPIXELS != 0 {
        masks[3]
    } else {
        0
    };
    Ok(Layout::Masks(Masks {
        bytes,
        channels: [masks[0], masks[1], masks[2], alpha],
        gray: false,
    }))
}

/// Scales the bits under one channel mask to 8 bits.
fn channel_value(pixel: u32, mask: u32) -> u8 {
    if mask == 0 {
        return 0;
    }
    let bits = mask.count_ones();
    let max = (1u64 << bits) - 1;
    let value = u64::from((pixel & mask) >> mask.trailing_zeros());
    ((value * 255 + max / 2) / max) as u8
}

fn unpack(masks: &Masks, data: &[u8], count: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(count * 4);
    for index in 0..count {
        let mut pixel = 0u32;
        for (shift, byte) in data[index * masks.bytes..][..masks.bytes]
            .iter()
            .enumerate()
        {
            pixel |= u32::from(*byte) << (8 * shift);
        }
        let red = channel_value(pixel, masks.channels[0]);
        let (green, blue) = if masks.gray {
            (red, red)
        } else {
            (
                channel_value(pixel, masks.channels[1]),
                channel_value(pixel, masks.channels[2]),
            )
        };
        let alpha = if masks.channels[3] == 0 {
            255
        } else {
            channel_value(pixel, masks.channels[3])
        };
        out.extend_from_slice(&[red, green, blue, alpha]);
    }
    out
}

/// Decodes a block-compressed level. The `texture2ddecoder` output is B, G, R, A in little-endian u32s.
fn unpack_blocks(
    block: Block,
    data: &[u8],
    width: usize,
    height: usize,
) -> Result<Vec<u8>, String> {
    let mut pixels = vec![0u32; width * height];
    let result = match block {
        Block::Bc1 => decode_bc1a(data, width, height, &mut pixels),
        Block::Bc2 => decode_bc2(data, width, height, &mut pixels),
        Block::Bc3 => decode_bc3(data, width, height, &mut pixels),
        Block::Bc4 => decode_bc4(data, width, height, &mut pixels),
        Block::Bc5 => decode_bc5(data, width, height, &mut pixels),
        Block::Bc6Unsigned => decode_bc6(data, width, height, &mut pixels, false),
        Block::Bc6Signed => decode_bc6(data, width, height, &mut pixels, true),
        Block::Bc7 => decode_bc7(data, width, height, &mut pixels),
    };
    result.map_err(|message| format!("could not decode the DDS texture: {message}"))?;
    let mut out = Vec::with_capacity(pixels.len() * 4);
    for value in pixels {
        out.extend_from_slice(&[
            (value >> 16) as u8,
            (value >> 8) as u8,
            value as u8,
            (value >> 24) as u8,
        ]);
    }
    Ok(out)
}

fn block_bytes(block: Block) -> usize {
    match block {
        Block::Bc1 | Block::Bc4 => 8,
        _ => 16,
    }
}

/// Reads a DDS file: the header, then the top mip level of the first array element (or the first
/// slice or face) as straight RGBA8.
pub fn decode(bytes: &[u8]) -> Result<Decoded, String> {
    if bytes.len() < HEADER_LEN || &bytes[..4] != MAGIC {
        return Err("the file is not a DDS texture".into());
    }
    if u32_at(bytes, 4) != 124 {
        return Err("bad DDS header size".into());
    }
    let height = u32_at(bytes, 12) as usize;
    let width = u32_at(bytes, 16) as usize;
    if width == 0 || height == 0 {
        return Err("bad DDS header: the image has no pixels".into());
    }
    let flags = u32_at(bytes, 80);
    let fourcc = &bytes[84..88];
    let bit_count = u32_at(bytes, 88);
    let masks = [
        u32_at(bytes, 92),
        u32_at(bytes, 96),
        u32_at(bytes, 100),
        u32_at(bytes, 104),
    ];
    let (layout, data_start) = if flags & DDPF_FOURCC != 0 && fourcc == b"DX10" {
        if bytes.len() < HEADER_LEN + DX10_LEN {
            return Err("the DDS file is truncated".into());
        }
        (
            layout_of_dxgi(u32_at(bytes, HEADER_LEN))?,
            HEADER_LEN + DX10_LEN,
        )
    } else if flags & DDPF_FOURCC != 0 {
        (Layout::Block(block_of_fourcc(fourcc)?), HEADER_LEN)
    } else {
        (layout_of_pixel_format(flags, bit_count, masks)?, HEADER_LEN)
    };
    let data = &bytes[data_start..];
    match layout {
        Layout::Block(block) => {
            let blocks = width.div_ceil(4) * height.div_ceil(4);
            let needed = blocks * block_bytes(block);
            if data.len() < needed {
                return Err("the DDS file is truncated".into());
            }
            Ok(Decoded {
                width,
                height,
                rgba: unpack_blocks(block, data, width, height)?,
            })
        }
        Layout::Masks(masks) => {
            let count = width * height;
            if data.len() < count * masks.bytes {
                return Err("the DDS file is truncated".into());
            }
            Ok(Decoded {
                width,
                height,
                rgba: unpack(&masks, data, count),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A DDS file with a legacy header of the given pixel format, followed by the level data.
    fn legacy(
        width: u32,
        height: u32,
        flags: u32,
        fourcc: &[u8; 4],
        bits: u32,
        masks: [u32; 4],
        data: &[u8],
    ) -> Vec<u8> {
        let mut out = vec![0u8; HEADER_LEN];
        out[..4].copy_from_slice(MAGIC);
        out[4..8].copy_from_slice(&124u32.to_le_bytes());
        out[12..16].copy_from_slice(&height.to_le_bytes());
        out[16..20].copy_from_slice(&width.to_le_bytes());
        out[76..80].copy_from_slice(&32u32.to_le_bytes());
        out[80..84].copy_from_slice(&flags.to_le_bytes());
        out[84..88].copy_from_slice(fourcc);
        out[88..92].copy_from_slice(&bits.to_le_bytes());
        for (i, mask) in masks.iter().enumerate() {
            out[92 + i * 4..96 + i * 4].copy_from_slice(&mask.to_le_bytes());
        }
        out.extend_from_slice(data);
        out
    }

    fn dx10(width: u32, height: u32, dxgi: u32, data: &[u8]) -> Vec<u8> {
        let mut out = legacy(width, height, DDPF_FOURCC, b"DX10", 0, [0; 4], &[]);
        out.truncate(HEADER_LEN);
        out.extend_from_slice(&dxgi.to_le_bytes());
        out.extend_from_slice(&[0; DX10_LEN - 4]);
        out.extend_from_slice(data);
        out
    }

    fn set_bits(block: &mut [u8], offset: usize, width: usize, value: u32) {
        for bit in 0..width {
            if (value >> bit) & 1 == 1 {
                let at = offset + bit;
                block[at / 8] |= 1 << (at % 8);
            }
        }
    }

    #[test]
    fn rejects_files_that_are_not_dds() {
        assert!(
            decode(b"not a dds file, but long enough to pass the length check.......").is_err()
        );
        assert!(decode(b"DDS ").is_err());
    }

    #[test]
    fn decodes_bgra_through_masks() {
        let file = legacy(
            2,
            1,
            DDPF_RGB | DDPF_ALPHAPIXELS,
            &[0; 4],
            32,
            [0xFF_0000, 0xFF00, 0xFF, 0xFF00_0000],
            &[10, 20, 30, 40, 1, 2, 3, 4],
        );
        let decoded = decode(&file).unwrap();
        assert_eq!((decoded.width, decoded.height), (2, 1));
        assert_eq!(decoded.rgba, vec![30, 20, 10, 40, 3, 2, 1, 4]);
    }

    #[test]
    fn scales_narrow_channels_to_eight_bits() {
        // RGB565: pure red is 31 of 31 and 0 of 63 green and blue.
        let file = legacy(
            1,
            1,
            DDPF_RGB,
            &[0; 4],
            16,
            [0xF800, 0x07E0, 0x001F, 0],
            &[0x00, 0xF8],
        );
        assert_eq!(decode(&file).unwrap().rgba, vec![255, 0, 0, 255]);
    }

    #[test]
    fn decodes_luminance_and_dx10_gray() {
        let luminance = legacy(1, 1, DDPF_LUMINANCE, &[0; 4], 8, [0xFF, 0, 0, 0], &[100]);
        assert_eq!(decode(&luminance).unwrap().rgba, vec![100, 100, 100, 255]);
        let gray = dx10(1, 1, 61, &[77]);
        assert_eq!(decode(&gray).unwrap().rgba, vec![77, 77, 77, 255]);
    }

    #[test]
    fn decodes_dx10_rgba8_with_the_dxgi_channel_order() {
        let rgba = dx10(1, 1, 28, &[1, 2, 3, 4]);
        assert_eq!(decode(&rgba).unwrap().rgba, vec![1, 2, 3, 4]);
        let bgra = dx10(1, 1, 87, &[1, 2, 3, 4]);
        assert_eq!(decode(&bgra).unwrap().rgba, vec![3, 2, 1, 4]);
    }

    #[test]
    fn decodes_a_bc1_block() {
        // Color 0 is pure red in RGB565, and color 1 is black, so the four-color mode picks red.
        let block = [0x00, 0xF8, 0x00, 0x00, 0, 0, 0, 0];
        let file = legacy(4, 4, DDPF_FOURCC, b"DXT1", 0, [0; 4], &block);
        let decoded = decode(&file).unwrap();
        for pixel in decoded.rgba.as_chunks::<4>().0 {
            assert_eq!(pixel, &[255, 0, 0, 255]);
        }
    }

    #[test]
    fn decodes_a_bc7_mode_6_block() {
        // Mode 6 has bit 6 of the first byte set and no bits before it. Endpoint 0 is 7-bit
        // values with a p-bit of 0, and every index is 0, so each pixel takes endpoint 0 exactly.
        let mut block = [0u8; 16];
        set_bits(&mut block, 0, 7, 1 << 6);
        let endpoints = [100, 0, 50, 0, 0, 0, 127, 0];
        let mut at = 7;
        for value in endpoints {
            set_bits(&mut block, at, 7, value);
            at += 7;
        }
        let file = dx10(4, 4, 98, &block);
        let decoded = decode(&file).unwrap();
        for pixel in decoded.rgba.as_chunks::<4>().0 {
            assert_eq!(pixel, &[200, 100, 0, 254]);
        }
    }

    #[test]
    fn a_truncated_level_is_refused() {
        let file = legacy(8, 8, DDPF_FOURCC, b"DXT5", 0, [0; 4], &[0; 16]);
        assert!(decode(&file).unwrap_err().contains("truncated"));
        let masks = legacy(
            4,
            4,
            DDPF_RGB,
            &[0; 4],
            32,
            [0xFF, 0xFF00, 0xFF_0000, 0],
            &[0; 8],
        );
        assert!(decode(&masks).is_err());
    }

    #[test]
    fn unsupported_formats_are_named() {
        let file = legacy(4, 4, DDPF_FOURCC, b"DX11", 0, [0; 4], &[0; 16]);
        assert!(decode(&file).unwrap_err().contains("DX11"));
    }
}
