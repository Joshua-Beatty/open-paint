//! TGA writer and reader (07 FMT-OPT-TGA-01).
//!
//! The writer emits a TGA 2.0 file: an 18-byte header, uncompressed or run-length (RLE) true-color
//! data, a 495-byte extension area (author, comments, date, software ID, alpha type) and a footer. The
//! reader handles image types 1, 2, 3 and their RLE forms 9, 10 and 11, pixel depths 8, 15, 16, 24 and
//! 32, color maps, and the origin and alpha rules of the header and extension area.

const HEADER: usize = 18;
const EXTENSION: usize = 495;
const FOOTER: usize = 26;
const SIGNATURE: &[u8] = b"TRUEVISION-XFILE.\0";
const SOFTWARE: &[u8] = b"OpenPaint";
/// The largest decoded image, in RGBA bytes, that the reader accepts.
const MAX_RGBA_BYTES: usize = 1 << 30;
/// Packets run at most this many pixels long (FMT-OPT-TGA-01).
const MAX_PACKET: usize = 128;
const ALPHA_NONE: u8 = 0;
const ALPHA_STRAIGHT: u8 = 3;
const ALPHA_PREMULTIPLIED: u8 = 4;

/// One image to write. `pixels` is RGB (24) or straight RGBA (32), top row first.
pub struct Spec<'a> {
    pub width: usize,
    pub height: usize,
    pub depth: u8,
    pub pixels: &'a [u8],
    pub rle: bool,
    /// Author name, up to 40 bytes. Empty leaves the field blank.
    pub author: &'a [u8],
    /// Comment text, split into lines of 80 bytes, at most four lines.
    pub comment: &'a [u8],
    /// Month, day, year, hour, minute and second of the save.
    pub date: [u16; 6],
}

/// A decoded image: straight RGBA, top row first.
pub struct Decoded {
    pub width: usize,
    pub height: usize,
    pub rgba: Vec<u8>,
    /// The author field of the extension area, up to its first NUL. Empty when there is none.
    pub author: Vec<u8>,
    /// The comment lines of the extension area, joined. Empty when there is none.
    pub comment: Vec<u8>,
}

/// Writes a TGA file with an 18-byte header, the pixel data (RLE per scanline when asked), the
/// extension area and the footer.
pub fn encode(spec: &Spec) -> Result<Vec<u8>, String> {
    let (width, height) = (spec.width, spec.height);
    if width == 0 || height == 0 || width > 0xFFFF || height > 0xFFFF {
        return Err("invalid TGA size".into());
    }
    let size = match spec.depth {
        24 => 3,
        32 => 4,
        depth => return Err(format!("unsupported TGA depth {depth}")),
    };
    let row = width * size;
    if spec.pixels.len() != row * height {
        return Err("TGA pixel data does not match the image size".into());
    }

    let mut out = Vec::with_capacity(HEADER + row * height + EXTENSION + FOOTER);
    let mut header = [0u8; HEADER];
    header[2] = if spec.rle { 10 } else { 2 };
    header[12..14].copy_from_slice(&(width as u16).to_le_bytes());
    header[14..16].copy_from_slice(&(height as u16).to_le_bytes());
    header[16] = spec.depth;
    header[17] = if spec.depth == 32 { 0x20 | 8 } else { 0x20 };
    out.extend_from_slice(&header);

    for scanline in spec.pixels.chunks_exact(row) {
        if spec.rle {
            rle_scanline(&mut out, scanline, size);
        } else {
            for pixel in scanline.chunks_exact(size) {
                push_bgr(&mut out, pixel);
            }
        }
    }

    let extension_at = out.len();
    out.extend_from_slice(&extension_area(spec));
    out.extend_from_slice(&(extension_at as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(SIGNATURE);
    Ok(out)
}

/// Appends one pixel in the file's B, G, R (and A) order.
fn push_bgr(out: &mut Vec<u8>, pixel: &[u8]) {
    out.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
    if let Some(&alpha) = pixel.get(3) {
        out.push(alpha);
    }
}

/// Writes one scanline as RLE packets (TGA 2.0 section 3.3). A run packet repeats one pixel, and a raw
/// packet lists distinct pixels. Packets never cross the scanline.
fn rle_scanline(out: &mut Vec<u8>, scanline: &[u8], size: usize) {
    let count = scanline.len() / size;
    let pixel = |i: usize| &scanline[i * size..(i + 1) * size];
    let mut i = 0;
    while i < count {
        let mut run = 1;
        while i + run < count && run < MAX_PACKET && pixel(i + run) == pixel(i) {
            run += 1;
        }
        if run >= 2 {
            out.push(0x80 | (run - 1) as u8);
            push_bgr(out, pixel(i));
            i += run;
            continue;
        }
        let start = i;
        let mut end = i + 1;
        while end < count
            && end - start < MAX_PACKET
            && !(end + 1 < count && pixel(end) == pixel(end + 1))
        {
            end += 1;
        }
        out.push((end - start - 1) as u8);
        for index in start..end {
            push_bgr(out, pixel(index));
        }
        i = end;
    }
}

/// The 495-byte extension area (TGA 2.0 section 4.2).
fn extension_area(spec: &Spec) -> Vec<u8> {
    let mut ext = vec![0u8; EXTENSION];
    ext[0..2].copy_from_slice(&(EXTENSION as u16).to_le_bytes());
    let author = trimmed(spec.author, 40);
    ext[2..2 + author.len()].copy_from_slice(author);
    for (line, chunk) in spec.comment.chunks(80).take(4).enumerate() {
        let at = 43 + line * 81;
        ext[at..at + chunk.len()].copy_from_slice(chunk);
    }
    for (slot, value) in spec.date.iter().enumerate() {
        ext[367 + slot * 2..369 + slot * 2].copy_from_slice(&value.to_le_bytes());
    }
    ext[426..426 + SOFTWARE.len()].copy_from_slice(SOFTWARE);
    ext[494] = if spec.depth == 32 {
        ALPHA_STRAIGHT
    } else {
        ALPHA_NONE
    };
    ext
}

fn trimmed(bytes: &[u8], max: usize) -> &[u8] {
    &bytes[..bytes.len().min(max)]
}

/// Reads a TGA file into straight RGBA. Errors name the defect in the header or the data.
pub fn decode(bytes: &[u8]) -> Result<Decoded, String> {
    if bytes.len() < HEADER {
        return Err("bad TGA header".into());
    }
    let id_length = usize::from(bytes[0]);
    let color_map_type = bytes[1];
    let image_type = bytes[2];
    let first_entry = u16::from_le_bytes([bytes[3], bytes[4]]) as usize;
    let map_length = u16::from_le_bytes([bytes[5], bytes[6]]) as usize;
    let map_bits = bytes[7];
    let width = u16::from_le_bytes([bytes[12], bytes[13]]) as usize;
    let height = u16::from_le_bytes([bytes[14], bytes[15]]) as usize;
    let depth = bytes[16];
    let descriptor = bytes[17];

    if !matches!(image_type, 1 | 2 | 3 | 9 | 10 | 11) {
        return Err("unknown TGA image type".into());
    }
    if color_map_type > 1 {
        return Err("Unknown TGA color map type.".into());
    }
    if width == 0 || height == 0 {
        return Err("bad TGA header".into());
    }
    let indexed = matches!(image_type, 1 | 9);
    let monochrome = matches!(image_type, 3 | 11);
    let rle = image_type >= 9;
    if indexed {
        if depth != 8 {
            return Err("bad TGA header: color-mapped images must be 8 bits".into());
        }
    } else if !matches!(depth, 8 | 15 | 16 | 24 | 32) {
        return Err("bad TGA header: pixelDepth not one of {8, 15, 16, 24, 32}".into());
    }
    if monochrome && depth != 8 {
        return Err("bad TGA header: monochrome images must be 8 bits".into());
    }
    let count = width * height;
    if count.saturating_mul(4) > MAX_RGBA_BYTES {
        return Err("TGA image too large".into());
    }

    let extension = extension_of(bytes);
    let attributes = extension.map(|area| area[EXTENSION - 1]);
    let (author, comment) = match extension {
        Some(area) => (
            text_field(&area[2..42]),
            (0..4)
                .flat_map(|line| text_field(&area[43 + line * 81..][..80]))
                .collect::<Vec<u8>>(),
        ),
        None => (Vec::new(), Vec::new()),
    };
    let alpha_bits = descriptor & 0x0F;
    let has_alpha = match attributes {
        Some(ALPHA_STRAIGHT | ALPHA_PREMULTIPLIED) => true,
        Some(_) => false,
        None => alpha_bits > 0 && matches!(depth, 16 | 32),
    };
    let premultiplied = attributes == Some(ALPHA_PREMULTIPLIED);

    let mut at = HEADER + id_length;
    let mut palette: Vec<[u8; 4]> = Vec::new();
    if color_map_type == 1 {
        let entry_bytes = match map_bits {
            15 | 16 => 2,
            24 => 3,
            32 => 4,
            _ => return Err("Bad TGA color map length.".into()),
        };
        if map_length > 256 {
            return Err("Bad TGA color map length.".into());
        }
        let map = bytes
            .get(at..at + map_length * entry_bytes)
            .ok_or("truncated TGA color map")?;
        palette = map
            .chunks_exact(entry_bytes)
            .map(|entry| color_map_entry(entry, has_alpha))
            .collect();
        at += map_length * entry_bytes;
    } else if indexed {
        return Err("bad TGA header: color-mapped images need a color map".into());
    }

    let size = match depth {
        8 => 1,
        15 | 16 => 2,
        24 => 3,
        _ => 4,
    };
    let data = bytes.get(at..).ok_or("truncated TGA data")?;
    let raw = if rle {
        expand_rle(data, count, size)?
    } else {
        data.get(..count * size)
            .ok_or("truncated TGA data")?
            .to_vec()
    };

    let top_left = descriptor & 0x20 != 0;
    let right_to_left = descriptor & 0x10 != 0;
    let mut rgba = vec![0u8; count * 4];
    for (index, pixel) in raw.chunks_exact(size).enumerate() {
        let (file_row, column) = (index / width, index % width);
        let row = if top_left {
            file_row
        } else {
            height - 1 - file_row
        };
        let column = if right_to_left {
            width - 1 - column
        } else {
            column
        };
        let color = if indexed {
            palette_entry(&palette, pixel[0], first_entry)
        } else if monochrome || depth == 8 {
            [pixel[0], pixel[0], pixel[0], 255]
        } else {
            direct_color(pixel, has_alpha)
        };
        rgba[(row * width + column) * 4..][..4].copy_from_slice(&color);
    }

    if has_alpha
        && rgba.as_chunks::<4>().0.iter().all(|p| p[3] == 0)
        && rgba.iter().any(|&v| v != 0)
    {
        for pixel in rgba.as_chunks_mut::<4>().0 {
            pixel[3] = 255;
        }
    }
    if premultiplied {
        for pixel in rgba.as_chunks_mut::<4>().0 {
            unpremultiply(pixel);
        }
    }

    Ok(Decoded {
        width,
        height,
        rgba,
        author,
        comment,
    })
}

/// The 495-byte extension area, or `None` when the file has none.
fn extension_of(bytes: &[u8]) -> Option<&[u8]> {
    if bytes.len() < FOOTER + HEADER || &bytes[bytes.len() - SIGNATURE.len()..] != SIGNATURE {
        return None;
    }
    let footer = bytes.len() - FOOTER;
    let extension_at = u32::from_le_bytes(bytes[footer..footer + 4].try_into().ok()?) as usize;
    if extension_at == 0 || extension_at + EXTENSION > bytes.len() {
        return None;
    }
    Some(&bytes[extension_at..extension_at + EXTENSION])
}

/// A fixed-size text field, up to its first NUL.
fn text_field(field: &[u8]) -> Vec<u8> {
    let end = field
        .iter()
        .position(|&byte| byte == 0)
        .unwrap_or(field.len());
    field[..end].to_vec()
}

/// A color-map entry as RGBA. Entries of 15, 16 and 24 bits are opaque.
fn color_map_entry(entry: &[u8], has_alpha: bool) -> [u8; 4] {
    match entry.len() {
        2 => {
            let value = u16::from_le_bytes([entry[0], entry[1]]);
            let alpha = if has_alpha && value & 0x8000 == 0 {
                0
            } else {
                255
            };
            let [r, g, b] = rgb15(value);
            [r, g, b, alpha]
        }
        3 => [entry[2], entry[1], entry[0], 255],
        _ => {
            let alpha = if has_alpha { entry[3] } else { 255 };
            [entry[2], entry[1], entry[0], alpha]
        }
    }
}

fn palette_entry(palette: &[[u8; 4]], index: u8, first: usize) -> [u8; 4] {
    usize::from(index)
        .checked_sub(first)
        .and_then(|slot| palette.get(slot))
        .copied()
        .unwrap_or([0, 0, 0, 255])
}

/// A 15 or 16-bit pixel (five bits per color) or a 24 or 32-bit pixel (B, G, R, then A).
fn direct_color(pixel: &[u8], has_alpha: bool) -> [u8; 4] {
    match pixel.len() {
        2 => {
            let value = u16::from_le_bytes([pixel[0], pixel[1]]);
            let alpha = if has_alpha && value & 0x8000 == 0 {
                0
            } else {
                255
            };
            let [r, g, b] = rgb15(value);
            [r, g, b, alpha]
        }
        3 => [pixel[2], pixel[1], pixel[0], 255],
        _ => [
            pixel[2],
            pixel[1],
            pixel[0],
            if has_alpha { pixel[3] } else { 255 },
        ],
    }
}

/// Expands a five-bit color channel to eight bits: the value is repeated into the low bits.
fn rgb15(value: u16) -> [u8; 3] {
    let expand = |bits: u16| {
        let five = (bits & 0x1F) as u8;
        (five << 3) | (five >> 2)
    };
    [expand(value >> 10), expand(value >> 5), expand(value)]
}

/// Divides the color channels by alpha (rounding to nearest) to undo premultiplication.
fn unpremultiply(pixel: &mut [u8]) {
    let alpha = u32::from(pixel[3]);
    if alpha == 0 {
        pixel[..3].fill(0);
        return;
    }
    for channel in pixel.iter_mut().take(3) {
        *channel = ((u32::from(*channel) * 255 + alpha / 2) / alpha).min(255) as u8;
    }
}

/// The raw pixel bytes of an RLE stream: `count` pixels of `size` bytes each.
fn expand_rle(data: &[u8], count: usize, size: usize) -> Result<Vec<u8>, String> {
    let total = count * size;
    let mut out = Vec::with_capacity(total);
    let mut i = 0;
    while out.len() < total {
        let header = *data.get(i).ok_or("truncated TGA RLE data")?;
        i += 1;
        let run = usize::from(header & 0x7F) + 1;
        if header & 0x80 != 0 {
            let pixel = data.get(i..i + size).ok_or("truncated TGA RLE data")?;
            for _ in 0..run {
                out.extend_from_slice(pixel);
            }
            i += size;
        } else {
            let literal = data
                .get(i..i + run * size)
                .ok_or("truncated TGA RLE data")?;
            out.extend_from_slice(literal);
            i += run * size;
        }
    }
    if out.len() != total {
        return Err("bad TGA RLE data".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixels(width: usize, height: usize, depth: u8) -> Vec<u8> {
        let size = if depth == 32 { 4 } else { 3 };
        let mut out = Vec::new();
        for y in 0..height {
            for x in 0..width {
                let mut p = vec![(x * 40) as u8, (y * 70) as u8, ((x + y) * 9) as u8];
                if size == 4 {
                    p.push(if (x + y) % 2 == 0 { 255 } else { 128 });
                }
                out.extend_from_slice(&p);
            }
        }
        out
    }

    fn spec<'a>(width: usize, height: usize, depth: u8, pixels: &'a [u8], rle: bool) -> Spec<'a> {
        Spec {
            width,
            height,
            depth,
            pixels,
            rle,
            author: b"",
            comment: b"",
            date: [10, 13, 2026, 9, 30, 5],
        }
    }

    #[test]
    fn writes_the_header_extension_and_footer() {
        let data = pixels(3, 2, 32);
        let bytes = encode(&spec(3, 2, 32, &data, false)).expect("encode");
        assert_eq!(bytes[2], 2);
        assert_eq!(&bytes[12..16], &[3, 0, 2, 0]);
        assert_eq!(bytes[16], 32);
        assert_eq!(bytes[17], 0x28);
        assert_eq!(bytes.len(), HEADER + 3 * 2 * 4 + EXTENSION + FOOTER);
        let footer = bytes.len() - FOOTER;
        assert_eq!(&bytes[bytes.len() - 18..], SIGNATURE);
        let extension_at =
            u32::from_le_bytes(bytes[footer..footer + 4].try_into().expect("4")) as usize;
        assert_eq!(extension_at, HEADER + 3 * 2 * 4);
        let ext = &bytes[extension_at..extension_at + EXTENSION];
        assert_eq!(&ext[426..435], SOFTWARE);
        assert_eq!(ext[494], ALPHA_STRAIGHT);
        assert_eq!(u16::from_le_bytes([ext[367], ext[368]]), 10);
    }

    #[test]
    fn round_trips_32_bit_with_alpha() {
        let data = pixels(5, 4, 32);
        let bytes = encode(&spec(5, 4, 32, &data, false)).expect("encode");
        let decoded = decode(&bytes).expect("decode");
        assert_eq!((decoded.width, decoded.height), (5, 4));
        assert_eq!(decoded.rgba, data);
    }

    #[test]
    fn reads_back_the_author_and_comment_fields() {
        let data = pixels(2, 2, 24);
        let comment = [b'x'; 100];
        let mut input = spec(2, 2, 24, &data, true);
        input.author = &b"Ada"[..];
        input.comment = &comment[..];
        let decoded = decode(&encode(&input).expect("encode")).expect("decode");
        assert_eq!(decoded.author, b"Ada");
        assert_eq!(decoded.comment, comment);
    }

    #[test]
    fn round_trips_24_bit_as_opaque() {
        let data = pixels(4, 3, 24);
        let bytes = encode(&spec(4, 3, 24, &data, false)).expect("encode");
        let decoded = decode(&bytes).expect("decode");
        let expected: Vec<u8> = data
            .as_chunks::<3>()
            .0
            .iter()
            .flat_map(|rgb| [rgb[0], rgb[1], rgb[2], 255])
            .collect();
        assert_eq!(decoded.rgba, expected);
    }

    #[test]
    fn rle_round_trips_and_packs_runs() {
        let mut data = Vec::new();
        for i in 0..300usize {
            let value = if i < 200 { 7u8 } else { (i % 5) as u8 };
            data.extend_from_slice(&[value, value, value, 255]);
        }
        let bytes = encode(&spec(300, 1, 32, &data, true)).expect("encode");
        assert_eq!(bytes[2], 10);
        assert!(bytes.len() < HEADER + 300 * 4 + EXTENSION + FOOTER);
        let decoded = decode(&bytes).expect("decode");
        assert_eq!(decoded.rgba, data);
    }

    #[test]
    fn decodes_a_bottom_up_rle_stream_with_a_color_map() {
        let mut bytes = vec![0u8; HEADER];
        bytes[1] = 1;
        bytes[2] = 9;
        bytes[5..7].copy_from_slice(&2u16.to_le_bytes());
        bytes[7] = 24;
        bytes[12..14].copy_from_slice(&3u16.to_le_bytes());
        bytes[14..16].copy_from_slice(&2u16.to_le_bytes());
        bytes[16] = 8;
        bytes[17] = 0;
        bytes.extend_from_slice(&[0, 0, 255, 0, 255, 0]);
        bytes.extend_from_slice(&[0x81, 1, 0x03, 0, 0, 1, 1]);
        let decoded = decode(&bytes).expect("decode");
        let red = [255, 0, 0, 255];
        let green = [0, 255, 0, 255];
        assert_eq!(decoded.rgba[0..4], red);
        assert_eq!(decoded.rgba[4..8], green);
        assert_eq!(decoded.rgba[8..12], green);
        assert_eq!(decoded.rgba[12..16], green);
        assert_eq!(decoded.rgba[20..24], red);
    }

    #[test]
    fn rejects_bad_headers_with_the_spec_messages() {
        let mut bytes = encode(&spec(2, 2, 24, &pixels(2, 2, 24), false)).expect("encode");
        bytes[2] = 4;
        assert_eq!(
            decode(&bytes).err().as_deref(),
            Some("unknown TGA image type")
        );
        bytes[2] = 2;
        bytes[16] = 12;
        assert_eq!(
            decode(&bytes).err().as_deref(),
            Some("bad TGA header: pixelDepth not one of {8, 15, 16, 24, 32}")
        );
        bytes[16] = 24;
        bytes[1] = 2;
        assert_eq!(
            decode(&bytes).err().as_deref(),
            Some("Unknown TGA color map type.")
        );
        assert!(decode(&bytes[..10]).is_err());
    }

    #[test]
    fn reads_15_bit_pixels() {
        let mut bytes = vec![0u8; HEADER];
        bytes[2] = 2;
        bytes[12..14].copy_from_slice(&2u16.to_le_bytes());
        bytes[14..16].copy_from_slice(&1u16.to_le_bytes());
        bytes[16] = 15;
        bytes[17] = 0x20;
        bytes.extend_from_slice(&0x7C00u16.to_le_bytes());
        bytes.extend_from_slice(&0x001Fu16.to_le_bytes());
        let decoded = decode(&bytes).expect("decode");
        assert_eq!(decoded.rgba[..4], [255, 0, 0, 255]);
        assert_eq!(decoded.rgba[4..8], [0, 0, 255, 255]);
    }

    #[test]
    fn rejects_truncated_data() {
        let data = pixels(4, 4, 32);
        let mut bytes = encode(&spec(4, 4, 32, &data, false)).expect("encode");
        bytes.truncate(HEADER + 20);
        assert!(decode(&bytes).is_err());
        assert!(encode(&spec(2, 2, 16, &pixels(2, 2, 24), false)).is_err());
        assert!(encode(&spec(2, 2, 24, &[0u8; 5], false)).is_err());
    }
}
