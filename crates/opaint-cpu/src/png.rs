//! PNG encoder for the flat formats (FMT-OPT-PNG-01, FMT-QNT-01 output).
//!
//! The caller prepares the pixels: flattening, alpha and palette decisions live in TypeScript. This
//! module writes the container: IHDR, Adam7 passes, the palette and transparency, the color profile,
//! the metadata chunks and pHYs. Deflate is miniz_oxide. Every row uses filter 0 (None).

use miniz_oxide::deflate::compress_to_vec_zlib;

const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

/// Adam7 passes as (x start, y start, x step, y step), in the order the spec writes them.
const ADAM7: [(usize, usize, usize, usize); 7] = [
    (0, 0, 8, 8),
    (4, 0, 8, 8),
    (0, 4, 4, 8),
    (2, 0, 4, 4),
    (0, 2, 2, 4),
    (1, 0, 2, 2),
    (0, 1, 1, 2),
];

const CRC_TABLE: [u32; 256] = crc_table();

/// The output depth: the 32-bit and 24-bit RGBA and RGB layouts, or an indexed depth of 1, 2, 4 or 8.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Depth {
    /// 32-bit: RGBA with 8 bits per channel (color type 6).
    Rgba8,
    /// 24-bit: RGB with 8 bits per channel (color type 2).
    Rgb8,
    /// Indexed with the given bits per pixel (color type 3).
    Indexed(u8),
}

impl Depth {
    /// Maps the DOC choice ids (32, 24, 8, 4, 2, 1) to a depth.
    pub fn from_bits(bits: u8) -> Result<Depth, String> {
        match bits {
            32 => Ok(Depth::Rgba8),
            24 => Ok(Depth::Rgb8),
            1 | 2 | 4 | 8 => Ok(Depth::Indexed(bits)),
            other => Err(format!("unsupported PNG bit depth {other}.")),
        }
    }

    /// Bytes per pixel in the input: four, three, or one palette index.
    fn input_channels(self) -> usize {
        match self {
            Depth::Rgba8 => 4,
            Depth::Rgb8 => 3,
            Depth::Indexed(_) => 1,
        }
    }
}

/// Everything the encoder writes for one image.
pub struct Spec<'a> {
    pub width: usize,
    pub height: usize,
    pub depth: Depth,
    /// Straight-alpha RGBA or RGB, or one palette index per pixel, row-major.
    pub pixels: &'a [u8],
    /// RGB triples of the palette. Required for indexed depths and ignored otherwise.
    pub palette: &'a [u8],
    /// One alpha value per palette entry (tRNS). Empty when every entry is opaque.
    pub alpha: &'a [u8],
    pub interlaced: bool,
    /// An ICC profile, embedded as an iCCP chunk. Empty for none.
    pub icc: &'a [u8],
    /// Pixels per meter (x, y), written as pHYs. `None` omits the chunk.
    pub pixels_per_meter: Option<(u32, u32)>,
    /// A TIFF-structured EXIF block, written as an eXIf chunk. Empty for none.
    pub exif: &'a [u8],
    /// XMP packets, each written as one iTXt chunk in order.
    pub xmp: &'a [&'a [u8]],
}

/// Encodes the image as a complete PNG file.
pub fn encode(spec: &Spec) -> Result<Vec<u8>, String> {
    let (width, height) = (spec.width, spec.height);
    if width == 0 || height == 0 {
        return Err("PNG dimensions must be at least 1 x 1.".into());
    }
    let channels = spec.depth.input_channels();
    if spec.pixels.len() != width * height * channels {
        return Err(format!(
            "Image data has {} bytes; expected {}.",
            spec.pixels.len(),
            width * height * channels
        ));
    }
    let entries = spec.palette.len() / 3;
    if let Depth::Indexed(bits) = spec.depth {
        if spec.palette.is_empty() || !spec.palette.len().is_multiple_of(3) {
            return Err("An indexed PNG needs RGB palette triples.".into());
        }
        if entries > 1usize << bits || spec.alpha.len() > entries {
            return Err("The palette is larger than the bit depth allows.".into());
        }
    }

    let passes = if spec.interlaced {
        ADAM7.to_vec()
    } else {
        vec![(0, 0, 1, 1)]
    };
    let mut raw = Vec::new();
    for (x0, y0, dx, dy) in passes {
        let columns: Vec<usize> = (x0..width).step_by(dx).collect();
        if columns.is_empty() {
            continue;
        }
        for y in (y0..height).step_by(dy) {
            push_row(&mut raw, spec, y, &columns, entries)?;
        }
    }
    let compressed = compress_to_vec_zlib(&raw, 9);

    let (depth_bits, color_type) = match spec.depth {
        Depth::Rgba8 => (8, 6),
        Depth::Rgb8 => (8, 2),
        Depth::Indexed(bits) => (bits, 3),
    };
    let mut header = Vec::with_capacity(13);
    header.extend_from_slice(&(width as u32).to_be_bytes());
    header.extend_from_slice(&(height as u32).to_be_bytes());
    header.extend_from_slice(&[depth_bits, color_type, 0, 0, u8::from(spec.interlaced)]);

    let mut out = SIGNATURE.to_vec();
    chunk(&mut out, b"IHDR", &header);
    if !spec.icc.is_empty() {
        let mut body = b"sRGB\0\0".to_vec();
        body.extend_from_slice(&compress_to_vec_zlib(spec.icc, 9));
        chunk(&mut out, b"iCCP", &body);
    }
    if let Some((x, y)) = spec.pixels_per_meter {
        let mut body = Vec::with_capacity(9);
        body.extend_from_slice(&x.to_be_bytes());
        body.extend_from_slice(&y.to_be_bytes());
        body.push(1);
        chunk(&mut out, b"pHYs", &body);
    }
    if let Depth::Indexed(_) = spec.depth {
        chunk(&mut out, b"PLTE", spec.palette);
        if !spec.alpha.is_empty() {
            chunk(&mut out, b"tRNS", spec.alpha);
        }
    }
    if !spec.exif.is_empty() {
        chunk(&mut out, b"eXIf", spec.exif);
    }
    for packet in spec.xmp {
        let mut body = b"XML:com.adobe.xmp".to_vec();
        body.extend_from_slice(&[0, 0, 0, 0, 0]);
        body.extend_from_slice(packet);
        chunk(&mut out, b"iTXt", &body);
    }
    chunk(&mut out, b"IDAT", &compressed);
    chunk(&mut out, b"IEND", &[]);
    Ok(out)
}

/// Appends one filtered scanline holding the pixels of row `y` at `columns`.
fn push_row(
    raw: &mut Vec<u8>,
    spec: &Spec,
    y: usize,
    columns: &[usize],
    entries: usize,
) -> Result<(), String> {
    raw.push(0);
    let width = spec.width;
    match spec.depth {
        Depth::Rgba8 | Depth::Rgb8 => {
            let channels = spec.depth.input_channels();
            for &x in columns {
                let start = (y * width + x) * channels;
                raw.extend_from_slice(&spec.pixels[start..start + channels]);
            }
        }
        Depth::Indexed(bits) => {
            let bits = usize::from(bits);
            let per_byte = 8 / bits;
            let mut byte = 0u8;
            let mut count = 0usize;
            for &x in columns {
                let index = spec.pixels[y * width + x];
                if usize::from(index) >= entries {
                    return Err(format!("Pixel index {index} is outside the palette."));
                }
                byte |= index << (8 - bits * (count + 1));
                count += 1;
                if count == per_byte {
                    raw.push(byte);
                    byte = 0;
                    count = 0;
                }
            }
            if count > 0 {
                raw.push(byte);
            }
        }
    }
    Ok(())
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], body: &[u8]) {
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(body);
    out.extend_from_slice(&crc32(&[&kind[..], body]).to_be_bytes());
}

const fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 {
                0xedb8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
            k += 1;
        }
        table[n] = c;
        n += 1;
    }
    table
}

/// CRC-32 (ISO 3309) over the concatenation of `parts`, as PNG chunks use it.
fn crc32(parts: &[&[u8]]) -> u32 {
    let mut crc = !0u32;
    for part in parts {
        for &byte in *part {
            crc = CRC_TABLE[((crc ^ u32::from(byte)) & 0xff) as usize] ^ (crc >> 8);
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Splits a PNG into (type, body) pairs and checks every CRC.
    fn chunks_of(png: &[u8]) -> Vec<([u8; 4], Vec<u8>)> {
        assert_eq!(&png[..8], &SIGNATURE);
        let mut found = Vec::new();
        let mut offset = 8;
        while offset < png.len() {
            let length = u32::from_be_bytes(png[offset..offset + 4].try_into().unwrap()) as usize;
            let kind: [u8; 4] = png[offset + 4..offset + 8].try_into().unwrap();
            let body = png[offset + 8..offset + 8 + length].to_vec();
            let crc = u32::from_be_bytes(
                png[offset + 8 + length..offset + 12 + length]
                    .try_into()
                    .unwrap(),
            );
            assert_eq!(crc32(&[&kind[..], &body[..]]), crc, "CRC of {kind:?}");
            found.push((kind, body));
            offset += length + 12;
        }
        found
    }

    fn idat(png: &[u8]) -> Vec<u8> {
        let data: Vec<u8> = chunks_of(png)
            .into_iter()
            .filter(|(kind, _)| kind == b"IDAT")
            .flat_map(|(_, body)| body)
            .collect();
        miniz_oxide::inflate::decompress_to_vec_zlib(&data).unwrap()
    }

    fn plain(width: usize, height: usize, depth: Depth, pixels: &[u8]) -> Spec<'_> {
        Spec {
            width,
            height,
            depth,
            pixels,
            palette: &[],
            alpha: &[],
            interlaced: false,
            icc: &[],
            pixels_per_meter: None,
            exif: &[],
            xmp: &[],
        }
    }

    #[test]
    fn crc_matches_the_iend_test_vector() {
        assert_eq!(crc32(&[b"IEND"]), 0xae42_6082);
    }

    #[test]
    fn packs_four_bit_indices_high_nibble_first() {
        let palette = [0u8; 3 * 4];
        let spec = Spec {
            palette: &palette,
            ..plain(3, 1, Depth::Indexed(4), &[0, 1, 2])
        };
        let png = encode(&spec).unwrap();
        assert_eq!(idat(&png), vec![0, 0x01, 0x20]);
        let header = &chunks_of(&png)[0].1;
        assert_eq!(header[8..13], [4, 3, 0, 0, 0]);
    }

    #[test]
    fn adam7_writes_each_pass_as_its_own_filtered_rows() {
        let palette: Vec<u8> = (0..9u8).flat_map(|i| [i, i, i]).collect();
        let pixels: Vec<u8> = (0..9u8).collect();
        let spec = Spec {
            palette: &palette,
            interlaced: true,
            ..plain(3, 3, Depth::Indexed(8), &pixels)
        };
        let png = encode(&spec).unwrap();
        // Passes 1, 4, 5, 6 and 7 hold pixels; pass 2 and 3 are empty for a 3 x 3 image.
        assert_eq!(
            idat(&png),
            vec![0, 0, 0, 2, 0, 6, 8, 0, 1, 0, 7, 0, 3, 4, 5]
        );
        assert_eq!(chunks_of(&png)[0].1[12], 1);
    }

    #[test]
    fn writes_chunks_in_the_order_the_spec_requires() {
        let palette = [1u8, 2, 3, 4, 5, 6];
        let alpha = [0u8, 255];
        let exif = [b'I', b'I', 42, 0, 8, 0, 0, 0, 0, 0];
        let xmp: [&[u8]; 1] = [b"<x:xmpmeta/>"];
        let spec = Spec {
            palette: &palette,
            alpha: &alpha,
            icc: &[1, 2, 3],
            pixels_per_meter: Some((3780, 3780)),
            exif: &exif,
            xmp: &xmp,
            ..plain(1, 1, Depth::Indexed(8), &[1])
        };
        let png = encode(&spec).unwrap();
        let kinds: Vec<String> = chunks_of(&png)
            .iter()
            .map(|(kind, _)| String::from_utf8_lossy(kind).into_owned())
            .collect();
        assert_eq!(
            kinds,
            ["IHDR", "iCCP", "pHYs", "PLTE", "tRNS", "eXIf", "iTXt", "IDAT", "IEND"]
        );
        let found = chunks_of(&png);
        assert_eq!(&found[1].1[..6], b"sRGB\0\0");
        assert_eq!(&found[2].1[..4], &3780u32.to_be_bytes());
        assert!(found[6]
            .1
            .starts_with(b"XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>"));
    }

    #[test]
    fn rgba_rows_keep_straight_alpha_bytes() {
        let pixels = [255u8, 0, 0, 128, 0, 255, 0, 0];
        let png = encode(&plain(2, 1, Depth::Rgba8, &pixels)).unwrap();
        assert_eq!(idat(&png), vec![0, 255, 0, 0, 128, 0, 255, 0, 0]);
    }

    #[test]
    fn rejects_bad_input() {
        assert!(encode(&plain(0, 1, Depth::Rgb8, &[])).is_err());
        assert!(encode(&plain(2, 1, Depth::Rgb8, &[1, 2, 3])).is_err());
        let palette = [0u8; 6];
        let spec = Spec {
            palette: &palette,
            ..plain(1, 1, Depth::Indexed(1), &[2])
        };
        assert!(encode(&spec).is_err());
        assert!(Depth::from_bits(16).is_err());
        assert!(encode(&plain(1, 1, Depth::Indexed(2), &[0])).is_err());
    }
}
