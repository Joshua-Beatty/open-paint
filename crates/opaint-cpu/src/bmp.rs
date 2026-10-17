//! BMP writer and reader (07 FMT-OPT-BMP-01, FMT-REG-02 row 10).
//!
//! The writer emits uncompressed BMP: indexed 8, 4 and 1-bit images with an RGB palette, 24-bit RGB,
//! and 32-bit BITMAPV5 with an alpha mask (bytes in B, G, R, A order). The reader handles the depths
//! BMP defines (1, 4, 8, 16, 24 and 32), RLE8 and RLE4, bitfield masks, and bottom-up or top-down rows.

const FILE_HEADER: usize = 14;
const INFO_HEADER: usize = 40;
const V5_HEADER: usize = 124;
const CORE_HEADER: usize = 12;
const LCS_SRGB: u32 = 0x7352_4742;
const LCS_PROFILE_EMBEDDED: u32 = 0x4D42_4544;
const LCS_GM_IMAGES: u32 = 4;
const BI_RGB: u32 = 0;
const BI_RLE8: u32 = 1;
const BI_RLE4: u32 = 2;
const BI_BITFIELDS: u32 = 3;
const BI_ALPHABITFIELDS: u32 = 6;
/// The largest decoded image, in RGBA bytes, that the reader accepts.
const MAX_RGBA_BYTES: usize = 1 << 30;

/// One image to write. `pixels` holds RGBA (32), RGB (24), or one palette index per pixel (8, 4, 1).
pub struct Spec<'a> {
    pub width: usize,
    pub height: usize,
    pub depth: u8,
    pub pixels: &'a [u8],
    /// RGB triples for the indexed depths.
    pub palette: &'a [u8],
    /// An ICC profile to embed. Empty writes no profile and marks the color space as sRGB.
    pub icc: &'a [u8],
    /// Pixels per meter for the header. Zero writes none.
    pub pixels_per_meter: (u32, u32),
}

/// A decoded image: straight RGBA, top row first.
pub struct Decoded {
    pub width: usize,
    pub height: usize,
    pub rgba: Vec<u8>,
    pub pixels_per_meter: (u32, u32),
    /// The embedded ICC profile of a BITMAPV5 header, or empty when there is none.
    pub icc: Vec<u8>,
}

/// Writes a BMP file. 32-bit images always use a BITMAPV5 header (FMT-OPT-BMP-01). Other depths use
/// BITMAPINFOHEADER unless a profile is embedded.
pub fn encode(spec: &Spec) -> Result<Vec<u8>, String> {
    let (width, height) = (spec.width, spec.height);
    if width == 0 || height == 0 || width > i32::MAX as usize || height > i32::MAX as usize {
        return Err("invalid BMP size".into());
    }
    let bits = usize::from(spec.depth);
    let count = width * height;
    let expected = match spec.depth {
        32 => count * 4,
        24 => count * 3,
        1 | 4 | 8 => count,
        depth => return Err(format!("unsupported BMP depth {depth}")),
    };
    if spec.pixels.len() != expected {
        return Err("BMP pixel data does not match the image size".into());
    }
    let indexed = matches!(spec.depth, 1 | 4 | 8);
    let entries = spec.palette.len() / 3;
    if indexed && (entries == 0 || entries > (1 << bits)) {
        return Err("BMP palette does not fit the depth".into());
    }
    let stride = (width * bits).div_ceil(32) * 4;
    let pixel_bytes = stride * height;
    let v5 = spec.depth == 32 || !spec.icc.is_empty();
    let header = if v5 { V5_HEADER } else { INFO_HEADER };
    let palette_bytes = if indexed { entries * 4 } else { 0 };
    let profile_offset = header + palette_bytes + pixel_bytes;
    let total = FILE_HEADER + profile_offset + spec.icc.len();
    if total > u32::MAX as usize {
        return Err("BMP image too large".into());
    }

    let mut out = vec![0u8; total];
    out[0..2].copy_from_slice(b"BM");
    put_u32(&mut out, 2, total as u32);
    put_u32(&mut out, 10, (FILE_HEADER + header + palette_bytes) as u32);

    let dib = FILE_HEADER;
    put_u32(&mut out, dib, header as u32);
    put_i32(&mut out, dib + 4, width as i32);
    put_i32(&mut out, dib + 8, height as i32);
    put_u16(&mut out, dib + 12, 1);
    put_u16(&mut out, dib + 14, u16::from(spec.depth));
    let compression = if spec.depth == 32 {
        BI_BITFIELDS
    } else {
        BI_RGB
    };
    put_u32(&mut out, dib + 16, compression);
    put_u32(&mut out, dib + 20, pixel_bytes as u32);
    put_i32(&mut out, dib + 24, spec.pixels_per_meter.0 as i32);
    put_i32(&mut out, dib + 28, spec.pixels_per_meter.1 as i32);
    put_u32(&mut out, dib + 32, if indexed { entries as u32 } else { 0 });
    if v5 {
        put_u32(&mut out, dib + 40, 0x00FF_0000);
        put_u32(&mut out, dib + 44, 0x0000_FF00);
        put_u32(&mut out, dib + 48, 0x0000_00FF);
        put_u32(&mut out, dib + 52, 0xFF00_0000);
        let embedded = !spec.icc.is_empty();
        put_u32(
            &mut out,
            dib + 56,
            if embedded {
                LCS_PROFILE_EMBEDDED
            } else {
                LCS_SRGB
            },
        );
        put_u32(&mut out, dib + 108, LCS_GM_IMAGES);
        if embedded {
            put_u32(&mut out, dib + 112, profile_offset as u32);
            put_u32(&mut out, dib + 116, spec.icc.len() as u32);
        }
    }

    let palette_at = dib + header;
    for (slot, rgb) in spec
        .palette
        .as_chunks::<3>()
        .0
        .iter()
        .take(palette_bytes / 4)
        .enumerate()
    {
        let at = palette_at + slot * 4;
        out[at] = rgb[2];
        out[at + 1] = rgb[1];
        out[at + 2] = rgb[0];
    }

    let pixels_at = palette_at + palette_bytes;
    for row in 0..height {
        let source_row = height - 1 - row;
        let target = pixels_at + row * stride;
        match spec.depth {
            32 => {
                for x in 0..width {
                    let s = &spec.pixels[(source_row * width + x) * 4..][..4];
                    let t = target + x * 4;
                    out[t] = s[2];
                    out[t + 1] = s[1];
                    out[t + 2] = s[0];
                    out[t + 3] = s[3];
                }
            }
            24 => {
                for x in 0..width {
                    let s = &spec.pixels[(source_row * width + x) * 3..][..3];
                    let t = target + x * 3;
                    out[t] = s[2];
                    out[t + 1] = s[1];
                    out[t + 2] = s[0];
                }
            }
            _ => {
                let source = &spec.pixels[source_row * width..][..width];
                for (x, &value) in source.iter().enumerate() {
                    let index = usize::from(value);
                    if index >= entries {
                        return Err("BMP palette index out of range".into());
                    }
                    let bit = x * bits;
                    let shift = 8 - bits - bit % 8;
                    out[target + bit / 8] |= (index as u8) << shift;
                }
            }
        }
    }

    if !spec.icc.is_empty() {
        out[dib + profile_offset..][..spec.icc.len()].copy_from_slice(spec.icc);
    }
    Ok(out)
}

/// Reads a BMP file into straight RGBA. Errors name the first defect found.
pub fn decode(bytes: &[u8]) -> Result<Decoded, String> {
    if bytes.len() < FILE_HEADER + 4 || &bytes[0..2] != b"BM" {
        return Err("not a BMP file".into());
    }
    let data_at = read_u32(bytes, 10)? as usize;
    let dib = FILE_HEADER;
    let header_size = read_u32(bytes, dib)? as usize;
    let info = Info::read(bytes, dib, header_size)?;
    if info.width == 0 || info.height == 0 {
        return Err("bad BMP size".into());
    }
    if info.width.saturating_mul(info.height).saturating_mul(4) > MAX_RGBA_BYTES {
        return Err("BMP image too large".into());
    }

    let entry_size = if header_size == CORE_HEADER { 3 } else { 4 };
    let palette_at = dib + header_size;
    let bpp = usize::from(info.bpp);
    let indexed = matches!(info.bpp, 1 | 4 | 8);
    let mut palette = Vec::new();
    if indexed {
        let max = 1usize << bpp;
        let count = if info.colors_used == 0 {
            max
        } else {
            (info.colors_used as usize).min(max)
        };
        for slot in 0..count {
            let at = palette_at + slot * entry_size;
            let entry = bytes.get(at..at + 3).ok_or("truncated BMP palette")?;
            palette.push([entry[2], entry[1], entry[0], 255]);
        }
    }

    let (width, height) = (info.width, info.height);
    let mut rgba = vec![0u8; width * height * 4];
    if indexed {
        let grid = if info.compression == BI_RLE8 || info.compression == BI_RLE4 {
            decode_rle(
                bytes.get(data_at..).unwrap_or(&[]),
                width,
                height,
                info.compression == BI_RLE4,
            )?
        } else if info.compression == BI_RGB {
            decode_packed(bytes, data_at, width, height, bpp)?
        } else {
            return Err(format!("unsupported BMP compression {}", info.compression));
        };
        for y in 0..height {
            let row = output_row(&info, y);
            for x in 0..width {
                let entry = palette
                    .get(usize::from(grid[row * width + x]))
                    .copied()
                    .unwrap_or([0, 0, 0, 255]);
                rgba[(y * width + x) * 4..][..4].copy_from_slice(&entry);
            }
        }
    } else {
        if info.compression != BI_RGB
            && info.compression != BI_BITFIELDS
            && info.compression != BI_ALPHABITFIELDS
        {
            return Err(format!("unsupported BMP compression {}", info.compression));
        }
        let stride = (width * bpp).div_ceil(32) * 4;
        let raw = bytes
            .get(data_at..data_at + stride * height)
            .ok_or("truncated BMP data")?;
        let masks = Masks::of(&info, bpp);
        for file_row in 0..height {
            let y = output_row(&info, file_row);
            let line = &raw[file_row * stride..];
            for x in 0..width {
                let value = match bpp {
                    16 => u32::from(u16::from_le_bytes([line[x * 2], line[x * 2 + 1]])),
                    24 => {
                        let p = &line[x * 3..][..3];
                        u32::from(p[0]) | u32::from(p[1]) << 8 | u32::from(p[2]) << 16
                    }
                    32 => u32::from_le_bytes(line[x * 4..][..4].try_into().unwrap_or([0; 4])),
                    _ => return Err(format!("unsupported BMP depth {bpp}")),
                };
                let pixel = masks.apply(value);
                rgba[(y * width + x) * 4..][..4].copy_from_slice(&pixel);
            }
        }
    }

    Ok(Decoded {
        width,
        height,
        rgba,
        pixels_per_meter: (info.ppm_x, info.ppm_y),
        icc: embedded_profile(bytes, dib, header_size),
    })
}

/// The fields of the DIB header the reader needs.
struct Info {
    width: usize,
    height: usize,
    top_down: bool,
    bpp: u16,
    compression: u32,
    colors_used: u32,
    ppm_x: u32,
    ppm_y: u32,
    masks: [u32; 4],
    has_masks: bool,
}

impl Info {
    fn read(bytes: &[u8], dib: usize, header_size: usize) -> Result<Info, String> {
        if header_size == CORE_HEADER {
            let width = u16::from_le_bytes(field(bytes, dib + 4)?) as usize;
            let height = u16::from_le_bytes(field(bytes, dib + 6)?) as usize;
            let bpp = u16::from_le_bytes(field(bytes, dib + 10)?);
            return Ok(Info {
                width,
                height,
                top_down: false,
                bpp,
                compression: BI_RGB,
                colors_used: 0,
                ppm_x: 0,
                ppm_y: 0,
                masks: [0; 4],
                has_masks: false,
            });
        }
        if header_size < INFO_HEADER {
            return Err("unsupported BMP header".into());
        }
        let width = read_i32(bytes, dib + 4)?;
        let height = read_i32(bytes, dib + 8)?;
        if width <= 0 || height == i32::MIN {
            return Err("bad BMP size".into());
        }
        let bpp = u16::from_le_bytes(field(bytes, dib + 14)?);
        let compression = read_u32(bytes, dib + 16)?;
        let ppm_x = read_i32(bytes, dib + 24)?.max(0) as u32;
        let ppm_y = read_i32(bytes, dib + 28)?.max(0) as u32;
        let colors_used = read_u32(bytes, dib + 32)?;
        let mut masks = [0u32; 4];
        let mut has_masks = false;
        if compression == BI_BITFIELDS || compression == BI_ALPHABITFIELDS {
            has_masks = true;
            for (slot, mask) in masks.iter_mut().enumerate().take(3) {
                *mask = read_u32(bytes, dib + 40 + slot * 4)?;
            }
            if header_size >= 56 || compression == BI_ALPHABITFIELDS {
                masks[3] = read_u32(bytes, dib + 52)?;
            }
        }
        Ok(Info {
            width: width as usize,
            height: height.unsigned_abs() as usize,
            top_down: height < 0,
            bpp,
            compression,
            colors_used,
            ppm_x,
            ppm_y,
            masks,
            has_masks,
        })
    }
}

/// The output row for a file row: bottom-up files store the last row first.
fn output_row(info: &Info, file_row: usize) -> usize {
    if info.top_down {
        file_row
    } else {
        info.height - 1 - file_row
    }
}

/// Channel extraction for the direct-color depths. The defaults are the ones BMP defines.
struct Masks {
    channels: [Option<(u32, u32)>; 4],
}

impl Masks {
    fn of(info: &Info, bpp: usize) -> Masks {
        let defaults: [u32; 4] = match bpp {
            16 => [0x7C00, 0x03E0, 0x001F, 0],
            24 => [0xFF_0000, 0xFF00, 0xFF, 0],
            _ => [0x00FF_0000, 0x0000_FF00, 0x0000_00FF, 0],
        };
        let raw = if info.has_masks { info.masks } else { defaults };
        let channels = raw.map(|mask| {
            if mask == 0 {
                None
            } else {
                Some((mask.trailing_zeros(), mask.count_ones()))
            }
        });
        Masks { channels }
    }

    /// Converts a stored value to straight RGBA. Red, green, blue come from the first three masks.
    fn apply(&self, value: u32) -> [u8; 4] {
        let channel = |slot: usize| match self.channels[slot] {
            Some((shift, bits)) => expand((value >> shift) & mask_of(bits), bits),
            None => 0,
        };
        let alpha = match self.channels[3] {
            Some((shift, bits)) => expand((value >> shift) & mask_of(bits), bits),
            None => 255,
        };
        [channel(0), channel(1), channel(2), alpha]
    }
}

fn mask_of(bits: u32) -> u32 {
    if bits >= 32 {
        u32::MAX
    } else {
        (1u32 << bits) - 1
    }
}

/// Scales a `bits`-wide value to 0 to 255, rounding to nearest.
fn expand(value: u32, bits: u32) -> u8 {
    if bits == 0 {
        return 0;
    }
    let max = u64::from(mask_of(bits));
    ((u64::from(value) * 255 + max / 2) / max) as u8
}

/// Indices of an uncompressed indexed image, in file row order (row 0 is the bottom row).
fn decode_packed(
    bytes: &[u8],
    data_at: usize,
    width: usize,
    height: usize,
    bpp: usize,
) -> Result<Vec<u8>, String> {
    let stride = (width * bpp).div_ceil(32) * 4;
    let raw = bytes
        .get(data_at..data_at + stride * height)
        .ok_or("truncated BMP data")?;
    let mut grid = vec![0u8; width * height];
    let mask = ((1u16 << bpp) - 1) as u8;
    for row in 0..height {
        for x in 0..width {
            let bit = x * bpp;
            let byte = raw[row * stride + bit / 8];
            let shift = 8 - bpp - bit % 8;
            grid[row * width + x] = (byte >> shift) & mask;
        }
    }
    Ok(grid)
}

/// Indices of an RLE4 or RLE8 image, in file row order. Delta and end-of-line codes move the cursor.
fn decode_rle(data: &[u8], width: usize, height: usize, four_bit: bool) -> Result<Vec<u8>, String> {
    let mut grid = vec![0u8; width * height];
    let (mut x, mut y, mut i) = (0usize, 0usize, 0usize);
    let put = |grid: &mut [u8], x: usize, y: usize, index: u8| {
        if x < width && y < height {
            grid[y * width + x] = index;
        }
    };
    while i + 1 < data.len() {
        let count = usize::from(data[i]);
        let value = data[i + 1];
        i += 2;
        if count > 0 {
            for k in 0..count {
                let index = if four_bit {
                    if k % 2 == 0 {
                        value >> 4
                    } else {
                        value & 0x0F
                    }
                } else {
                    value
                };
                put(&mut grid, x, y, index);
                x += 1;
            }
            continue;
        }
        match value {
            0 => {
                x = 0;
                y += 1;
            }
            1 => break,
            2 => {
                let dx = usize::from(*data.get(i).ok_or("truncated BMP RLE data")?);
                let dy = usize::from(*data.get(i + 1).ok_or("truncated BMP RLE data")?);
                i += 2;
                x += dx;
                y += dy;
            }
            run => {
                let run = usize::from(run);
                let bytes = if four_bit { run.div_ceil(2) } else { run };
                let literal = data.get(i..i + bytes).ok_or("truncated BMP RLE data")?;
                for k in 0..run {
                    let index = if four_bit {
                        let byte = literal[k / 2];
                        if k % 2 == 0 {
                            byte >> 4
                        } else {
                            byte & 0x0F
                        }
                    } else {
                        literal[k]
                    };
                    put(&mut grid, x, y, index);
                    x += 1;
                }
                i += bytes + (bytes % 2);
            }
        }
    }
    Ok(grid)
}

fn field(bytes: &[u8], at: usize) -> Result<[u8; 2], String> {
    bytes
        .get(at..at + 2)
        .and_then(|slice| slice.try_into().ok())
        .ok_or_else(|| "truncated BMP header".into())
}

fn read_u32(bytes: &[u8], at: usize) -> Result<u32, String> {
    bytes
        .get(at..at + 4)
        .and_then(|slice| slice.try_into().ok())
        .map(u32::from_le_bytes)
        .ok_or_else(|| "truncated BMP header".into())
}

/// The embedded ICC profile of a BITMAPV5 header. Its offset and size are relative to the header. A
/// linked profile, or one that lies outside the file, is ignored.
fn embedded_profile(bytes: &[u8], dib: usize, header_size: usize) -> Vec<u8> {
    if header_size < V5_HEADER || read_u32(bytes, dib + 56).ok() != Some(LCS_PROFILE_EMBEDDED) {
        return Vec::new();
    }
    let (Ok(offset), Ok(length)) = (read_u32(bytes, dib + 112), read_u32(bytes, dib + 116)) else {
        return Vec::new();
    };
    dib.checked_add(offset as usize)
        .and_then(|start| bytes.get(start..start.checked_add(length as usize)?))
        .map(<[u8]>::to_vec)
        .unwrap_or_default()
}

fn read_i32(bytes: &[u8], at: usize) -> Result<i32, String> {
    read_u32(bytes, at).map(|value| value as i32)
}

fn put_u16(out: &mut [u8], at: usize, value: u16) {
    out[at..at + 2].copy_from_slice(&value.to_le_bytes());
}

fn put_u32(out: &mut [u8], at: usize, value: u32) {
    out[at..at + 4].copy_from_slice(&value.to_le_bytes());
}

fn put_i32(out: &mut [u8], at: usize, value: i32) {
    out[at..at + 4].copy_from_slice(&value.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(width: usize, height: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(width * height * 4);
        for y in 0..height {
            for x in 0..width {
                out.extend_from_slice(&[
                    (x * 37) as u8,
                    (y * 53) as u8,
                    ((x + y) * 11) as u8,
                    (255 - (x * 9) as u8).wrapping_add(y as u8),
                ]);
            }
        }
        out
    }

    fn spec<'a>(
        width: usize,
        height: usize,
        depth: u8,
        pixels: &'a [u8],
        palette: &'a [u8],
    ) -> Spec<'a> {
        Spec {
            width,
            height,
            depth,
            pixels,
            palette,
            icc: &[],
            pixels_per_meter: (2835, 2835),
        }
    }

    #[test]
    fn writes_a_bitmapv5_header_for_32_bit() {
        let pixels = gradient(3, 2);
        let bytes = encode(&spec(3, 2, 32, &pixels, &[])).expect("encode");
        assert_eq!(&bytes[0..2], b"BM");
        assert_eq!(read_u32(&bytes, 14).expect("size"), 124);
        assert_eq!(read_u32(&bytes, 10).expect("offset"), 14 + 124);
        assert_eq!(
            read_u32(&bytes, 14 + 16).expect("compression"),
            BI_BITFIELDS
        );
        assert_eq!(read_u32(&bytes, 14 + 52).expect("alpha mask"), 0xFF00_0000);
        assert_eq!(read_u32(&bytes, 14 + 56).expect("color space"), LCS_SRGB);
    }

    #[test]
    fn round_trips_32_bit_with_alpha() {
        let pixels = gradient(5, 4);
        let bytes = encode(&spec(5, 4, 32, &pixels, &[])).expect("encode");
        let decoded = decode(&bytes).expect("decode");
        assert_eq!((decoded.width, decoded.height), (5, 4));
        assert_eq!(decoded.rgba, pixels);
        assert_eq!(decoded.pixels_per_meter, (2835, 2835));
    }

    #[test]
    fn round_trips_24_bit_with_row_padding() {
        let mut pixels = Vec::new();
        for i in 0..(3 * 5) {
            pixels.extend_from_slice(&[i as u8, (i * 2) as u8, (i * 3) as u8]);
        }
        let bytes = encode(&spec(3, 5, 24, &pixels, &[])).expect("encode");
        let decoded = decode(&bytes).expect("decode");
        let expected: Vec<u8> = pixels
            .as_chunks::<3>()
            .0
            .iter()
            .flat_map(|rgb| [rgb[0], rgb[1], rgb[2], 255])
            .collect();
        assert_eq!(decoded.rgba, expected);
    }

    #[test]
    fn round_trips_indexed_depths() {
        for (depth, colors) in [(1u8, 2usize), (4, 16), (8, 256)] {
            let width = 7;
            let height = 3;
            let palette: Vec<u8> = (0..colors)
                .flat_map(|i| [i as u8, 255 - i as u8, 9])
                .collect();
            let indices: Vec<u8> = (0..width * height).map(|i| (i % colors) as u8).collect();
            let bytes = encode(&spec(width, height, depth, &indices, &palette)).expect("encode");
            let decoded = decode(&bytes).expect("decode");
            for (pixel, &index) in indices.iter().enumerate() {
                let i = usize::from(index) * 3;
                assert_eq!(
                    &decoded.rgba[pixel * 4..pixel * 4 + 4],
                    &[palette[i], palette[i + 1], palette[i + 2], 255],
                    "depth {depth} pixel {pixel}"
                );
            }
        }
    }

    #[test]
    fn embeds_a_profile_in_a_bitmapv5_header() {
        let pixels = vec![9u8; 2 * 2 * 3];
        let icc = [1u8, 2, 3, 4, 5];
        let mut input = spec(2, 2, 24, &pixels, &[]);
        input.icc = &icc;
        let bytes = encode(&input).expect("encode");
        assert_eq!(read_u32(&bytes, 14).expect("size"), 124);
        assert_eq!(
            read_u32(&bytes, 14 + 56).expect("color space"),
            LCS_PROFILE_EMBEDDED
        );
        let at = read_u32(&bytes, 14 + 112).expect("profile offset") as usize;
        let length = read_u32(&bytes, 14 + 116).expect("profile size") as usize;
        assert_eq!(&bytes[14 + at..14 + at + length], &icc);
        assert_eq!(decode(&bytes).expect("decode").icc, icc);
    }

    #[test]
    fn decodes_rle8_with_an_end_of_line_and_an_absolute_run() {
        let body = [2, 1, 0, 0, 0, 3, 2, 0, 1, 0, 0, 1];
        let mut bytes = encoded_indexed_header(3, 2, 8, 2, BI_RLE8, body.len());
        bytes.extend_from_slice(&[0, 0, 0, 0, 0, 0, 255, 0]);
        let data_at = bytes.len();
        bytes.extend_from_slice(&body);
        bytes[10..14].copy_from_slice(&(data_at as u32).to_le_bytes());
        let decoded = decode(&bytes).expect("decode");
        let red_row =
            |row: &[u8]| -> Vec<u8> { row.as_chunks::<4>().0.iter().map(|p| p[0]).collect() };
        let top = &decoded.rgba[..3 * 4];
        let bottom = &decoded.rgba[3 * 4..];
        assert_eq!(red_row(top), vec![0, 0, 255]);
        assert_eq!(red_row(bottom), vec![255, 255, 0]);
    }

    fn encoded_indexed_header(
        width: usize,
        height: usize,
        depth: u16,
        colors: u32,
        compression: u32,
        size: usize,
    ) -> Vec<u8> {
        let mut bytes = vec![0u8; 14 + 40];
        bytes[0..2].copy_from_slice(b"BM");
        bytes[14..18].copy_from_slice(&40u32.to_le_bytes());
        bytes[18..22].copy_from_slice(&(width as i32).to_le_bytes());
        bytes[22..26].copy_from_slice(&(height as i32).to_le_bytes());
        bytes[26..28].copy_from_slice(&1u16.to_le_bytes());
        bytes[28..30].copy_from_slice(&depth.to_le_bytes());
        bytes[30..34].copy_from_slice(&compression.to_le_bytes());
        bytes[34..38].copy_from_slice(&(size as u32).to_le_bytes());
        bytes[46..50].copy_from_slice(&colors.to_le_bytes());
        bytes
    }

    #[test]
    fn decodes_rle4_nibbles() {
        let mut palette = Vec::new();
        for i in 0..16u8 {
            palette.extend_from_slice(&[0, 0, i * 16, 0]);
        }
        let body = [0, 4, 0x12, 0x34, 0, 0, 0, 1];
        let mut bytes = encoded_indexed_header(4, 1, 4, 16, BI_RLE4, body.len());
        bytes.extend_from_slice(&palette);
        let data_at = bytes.len();
        bytes.extend_from_slice(&body);
        bytes[10..14].copy_from_slice(&(data_at as u32).to_le_bytes());
        let decoded = decode(&bytes).expect("decode");
        let reds: Vec<u8> = decoded
            .rgba
            .as_chunks::<4>()
            .0
            .iter()
            .map(|p| p[0])
            .collect();
        assert_eq!(reds, vec![16, 32, 48, 64]);
    }

    #[test]
    fn rejects_bad_input() {
        assert!(decode(b"nope").is_err());
        let pixels = gradient(2, 2);
        let mut bytes = encode(&spec(2, 2, 32, &pixels, &[])).expect("encode");
        bytes.truncate(bytes.len() - 3);
        assert!(decode(&bytes).is_err());
        assert!(encode(&spec(2, 2, 16, &pixels, &[])).is_err());
        assert!(encode(&spec(2, 2, 8, &[0, 1, 2, 3], &[0, 0, 0])).is_err());
    }
}
