//! LZ4 block format (the history spill codec, ARC-05-01 / WEB-MEM-01). A greedy hash-chain-free
//! encoder with a 16K-entry table, and a bounds-checked decoder. Output follows the LZ4 block
//! specification, so any LZ4 block decoder can read it: the last 5 bytes are literals and no match
//! starts in the last 12 bytes.

const MIN_MATCH: usize = 4;
const MF_LIMIT: usize = 12;
const LAST_LITERALS: usize = 5;
const MAX_OFFSET: usize = 65_535;
const HASH_BITS: u32 = 14;

/// Compresses `src` into an LZ4 block. Empty input yields a single zero token.
pub fn compress(src: &[u8]) -> Vec<u8> {
    let n = src.len();
    let mut out = Vec::with_capacity(n / 2 + 16);
    if n < MF_LIMIT + 1 {
        emit_last_literals(&mut out, src);
        return out;
    }

    let mut table = vec![0u32; 1 << HASH_BITS];
    let match_limit = n - MF_LIMIT;
    let match_end_limit = n - LAST_LITERALS;
    let mut anchor = 0;
    let mut i = 0;

    while i < match_limit {
        let seq = read_u32(src, i);
        let slot = hash(seq);
        let candidate = table[slot] as usize;
        table[slot] = i as u32;

        if candidate >= i || i - candidate > MAX_OFFSET || read_u32(src, candidate) != seq {
            i += 1;
            continue;
        }

        let mut len = MIN_MATCH;
        while i + len < match_end_limit && src[i + len] == src[candidate + len] {
            len += 1;
        }

        emit_sequence(&mut out, &src[anchor..i], i - candidate, len);
        i += len;
        anchor = i;
    }

    emit_last_literals(&mut out, &src[anchor..]);
    out
}

/// Decompresses an LZ4 block that must expand to exactly `uncompressed_len` bytes.
pub fn decompress(src: &[u8], uncompressed_len: usize) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(uncompressed_len);
    let mut i = 0;

    while i < src.len() {
        let token = src[i];
        i += 1;

        let literal_len = read_length(src, &mut i, token >> 4)?;
        let literal_end = i
            .checked_add(literal_len)
            .filter(|&end| end <= src.len())
            .ok_or("LZ4 literal run exceeds the input.")?;
        if out.len() + literal_len > uncompressed_len {
            return Err("LZ4 output exceeds the expected length.".into());
        }
        out.extend_from_slice(&src[i..literal_end]);
        i = literal_end;

        if i == src.len() {
            break;
        }

        if i + 2 > src.len() {
            return Err("LZ4 match offset is truncated.".into());
        }
        let offset = usize::from(u16::from_le_bytes([src[i], src[i + 1]]));
        i += 2;
        if offset == 0 || offset > out.len() {
            return Err("LZ4 match offset points before the output.".into());
        }

        let match_len = read_length(src, &mut i, token & 0x0f)? + MIN_MATCH;
        if out.len() + match_len > uncompressed_len {
            return Err("LZ4 output exceeds the expected length.".into());
        }
        let start = out.len() - offset;
        for k in 0..match_len {
            let byte = out[start + k];
            out.push(byte);
        }
    }

    if out.len() != uncompressed_len {
        return Err(format!(
            "LZ4 block expanded to {} bytes, expected {uncompressed_len}.",
            out.len()
        ));
    }
    Ok(out)
}

fn hash(seq: u32) -> usize {
    (seq.wrapping_mul(2_654_435_761) >> (32 - HASH_BITS)) as usize
}

fn read_u32(src: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([src[at], src[at + 1], src[at + 2], src[at + 3]])
}

/// Reads an extended length when the 4-bit nibble is 15 (LZ4 `255` continuation bytes).
fn read_length(src: &[u8], i: &mut usize, nibble: u8) -> Result<usize, String> {
    let mut len = usize::from(nibble);
    if nibble == 15 {
        loop {
            let byte = *src.get(*i).ok_or("LZ4 length is truncated.")?;
            *i += 1;
            len += usize::from(byte);
            if byte != 255 {
                break;
            }
        }
    }
    Ok(len)
}

fn push_length(out: &mut Vec<u8>, mut len: usize) {
    while len >= 255 {
        out.push(255);
        len -= 255;
    }
    out.push(len as u8);
}

fn emit_sequence(out: &mut Vec<u8>, literals: &[u8], offset: usize, match_len: usize) {
    let extra = match_len - MIN_MATCH;
    out.push(((literals.len().min(15) as u8) << 4) | extra.min(15) as u8);
    if literals.len() >= 15 {
        push_length(out, literals.len() - 15);
    }
    out.extend_from_slice(literals);
    out.extend_from_slice(&(offset as u16).to_le_bytes());
    if extra >= 15 {
        push_length(out, extra - 15);
    }
}

fn emit_last_literals(out: &mut Vec<u8>, literals: &[u8]) {
    out.push((literals.len().min(15) as u8) << 4);
    if literals.len() >= 15 {
        push_length(out, literals.len() - 15);
    }
    out.extend_from_slice(literals);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(data: &[u8]) -> Vec<u8> {
        let packed = compress(data);
        assert_eq!(decompress(&packed, data.len()).expect("decodes"), data);
        packed
    }

    /// Deterministic noise (xorshift) so the tests need no RNG crate.
    fn noise(len: usize, mut seed: u32) -> Vec<u8> {
        (0..len)
            .map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                (seed >> 24) as u8
            })
            .collect()
    }

    #[test]
    fn round_trips_empty_and_short_inputs() {
        round_trip(&[]);
        round_trip(&[7]);
        round_trip(b"short text, under the match limit");
        round_trip(&[1; 12]);
        round_trip(&[1; 13]);
    }

    #[test]
    fn compresses_repetitive_data_well() {
        let data: Vec<u8> = (0..65_536).map(|i| (i % 7) as u8).collect();
        let packed = round_trip(&data);
        assert!(
            packed.len() < data.len() / 20,
            "packed to {} bytes",
            packed.len()
        );
    }

    #[test]
    fn handles_long_literal_and_match_lengths() {
        let mut data = noise(1_000, 0x9e37_79b9);
        data.extend(std::iter::repeat_n(0xab, 5_000));
        data.extend(noise(700, 0x1234_5678));
        round_trip(&data);
    }

    #[test]
    fn round_trips_incompressible_noise() {
        let data = noise(65_536, 0xdead_beef);
        let packed = round_trip(&data);
        assert!(packed.len() <= data.len() + data.len() / 200 + 16);
    }

    #[test]
    fn rejects_corrupt_blocks() {
        let data: Vec<u8> = (0..4_096).map(|i| (i % 13) as u8).collect();
        let packed = compress(&data);
        assert!(decompress(&packed, data.len() + 1).is_err());
        assert!(decompress(&packed[..packed.len() - 1], data.len()).is_err());
        assert!(decompress(&[0x10], 1).is_err());
        assert!(decompress(&[0x00, 0x05, 0x00], 1).is_err());
        assert!(decompress(&[0xf0], 3).is_err());
    }
}
