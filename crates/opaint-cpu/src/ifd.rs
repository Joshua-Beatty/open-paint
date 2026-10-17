//! TIFF-structured IFD0 entries (07 FMT-META-05, FMT-NAT-07). A TIFF file keeps its metadata in IFD0,
//! and an EXIF block (the PNG `eXIf` chunk and the JPEG APP1 payload) has the same structure. One reader
//! and one layout serve the TIFF codec and the EXIF block. Entry values are kept in little-endian order.

const HEADER_LEN: usize = 8;
const ENTRY_LEN: usize = 12;
/// The IFD0 pointers to the EXIF and GPS sub-IFDs, and the pointer inside EXIF to the interoperability IFD.
pub const EXIF_IFD: u16 = 34665;
pub const GPS_IFD: u16 = 34853;
const INTEROPERABILITY_IFD: u16 = 40965;

/// One IFD entry. `data` holds the value, `count` times the size of its field type, little-endian.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub tag: u16,
    pub kind: u16,
    pub count: u32,
    pub data: Vec<u8>,
}

impl Entry {
    /// An entry whose `data` already holds `count` little-endian values of `kind`.
    pub fn new(tag: u16, kind: u16, count: u32, data: Vec<u8>) -> Self {
        Self {
            tag,
            kind,
            count,
            data,
        }
    }

    /// A SHORT (type 3) entry with one value.
    pub fn short(tag: u16, value: u16) -> Self {
        Self::new(tag, 3, 1, value.to_le_bytes().to_vec())
    }

    /// A SHORT (type 3) entry with one value for each element of `values`.
    pub fn shorts(tag: u16, values: &[u16]) -> Self {
        let data = values
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect();
        Self::new(tag, 3, values.len() as u32, data)
    }

    /// A LONG (type 4) entry with one value.
    pub fn long(tag: u16, value: u32) -> Self {
        Self::new(tag, 4, 1, value.to_le_bytes().to_vec())
    }

    /// A RATIONAL (type 5) entry with one fraction.
    pub fn rational(tag: u16, numerator: u32, denominator: u32) -> Self {
        let mut data = numerator.to_le_bytes().to_vec();
        data.extend_from_slice(&denominator.to_le_bytes());
        Self::new(tag, 5, 1, data)
    }
}

/// The size in bytes of one value of a TIFF field type, or None for a type this module does not read.
fn element_size(kind: u16) -> Option<usize> {
    match kind {
        1 | 2 | 6 | 7 => Some(1),
        3 | 8 => Some(2),
        4 | 9 | 11 => Some(4),
        5 | 10 | 12 => Some(8),
        _ => None,
    }
}

fn read_u16(block: &[u8], at: usize, big: bool) -> Option<u16> {
    let bytes: [u8; 2] = block.get(at..at.checked_add(2)?)?.try_into().ok()?;
    Some(if big {
        u16::from_be_bytes(bytes)
    } else {
        u16::from_le_bytes(bytes)
    })
}

fn read_u32(block: &[u8], at: usize, big: bool) -> Option<u32> {
    let bytes: [u8; 4] = block.get(at..at.checked_add(4)?)?.try_into().ok()?;
    Some(if big {
        u32::from_be_bytes(bytes)
    } else {
        u32::from_le_bytes(bytes)
    })
}

/// The bytes of one value array in little-endian order. Only big-endian blocks swap anything.
fn little_endian(bytes: &[u8], size: usize, big: bool) -> Vec<u8> {
    if !big || size == 1 {
        return bytes.to_vec();
    }
    bytes
        .chunks_exact(size)
        .flat_map(|element| element.iter().rev().copied())
        .collect()
}

/// Whether a TIFF-structured block is big-endian, or None when its header is not a TIFF header.
fn big_endian(block: &[u8]) -> Option<bool> {
    let big = match block.get(0..2)? {
        b"II" => false,
        b"MM" => true,
        _ => return None,
    };
    (read_u16(block, 2, big)? == 42).then_some(big)
}

/// Overwrites the value of the one-value SHORT entry `tag` in IFD0 of a TIFF-structured block. Returns
/// false when the block has no such entry.
pub fn set_short(block: &mut [u8], tag: u16, value: u16) -> bool {
    let Some(big) = big_endian(block) else {
        return false;
    };
    let Some(ifd) = read_u32(block, 4, big).map(|offset| offset as usize) else {
        return false;
    };
    let Some(count) = read_u16(block, ifd, big) else {
        return false;
    };
    for index in 0..usize::from(count) {
        let at = ifd + 2 + index * ENTRY_LEN;
        let matches = read_u16(block, at, big) == Some(tag)
            && read_u16(block, at + 2, big) == Some(3)
            && read_u32(block, at + 4, big) == Some(1);
        if matches {
            let bytes = if big {
                value.to_be_bytes()
            } else {
                value.to_le_bytes()
            };
            block[at + 8..at + 10].copy_from_slice(&bytes);
            return true;
        }
    }
    false
}

/// The IFD0 entries of a TIFF-structured block, with values in little-endian order. Entries of a type
/// this module does not know are skipped. None when the header or the IFD is malformed.
pub fn ifd0_entries(block: &[u8]) -> Option<Vec<Entry>> {
    let big = big_endian(block)?;
    let ifd = read_u32(block, 4, big)? as usize;
    read_ifd(block, big, ifd)
}

/// The entries of the IFD at `ifd`, as `ifd0_entries` reads them.
fn read_ifd(block: &[u8], big: bool, ifd: usize) -> Option<Vec<Entry>> {
    let count = read_u16(block, ifd, big)? as usize;
    let mut entries = Vec::with_capacity(count);
    for index in 0..count {
        let at = ifd + 2 + index * ENTRY_LEN;
        let tag = read_u16(block, at, big)?;
        let kind = read_u16(block, at + 2, big)?;
        let values = read_u32(block, at + 4, big)?;
        let Some(size) = element_size(kind) else {
            continue;
        };
        let total = size.checked_mul(values as usize)?;
        let data_at = if total <= 4 {
            at + 8
        } else {
            read_u32(block, at + 8, big)? as usize
        };
        let bytes = block.get(data_at..data_at.checked_add(total)?)?;
        entries.push(Entry::new(
            tag,
            kind,
            values,
            little_endian(bytes, size, big),
        ));
    }
    Some(entries)
}

/// The EXIF and GPS sub-IFDs that IFD0 points to (tags 34665 and 34853), each as its tag and entries.
/// An interoperability pointer inside the EXIF sub-IFD is dropped, since its offset would not survive
/// the copy. A sub-IFD that cannot be read is left out.
pub fn sub_ifds(block: &[u8]) -> Vec<(u16, Vec<Entry>)> {
    let (Some(big), Some(entries)) = (big_endian(block), ifd0_entries(block)) else {
        return Vec::new();
    };
    [EXIF_IFD, GPS_IFD]
        .into_iter()
        .filter_map(|tag| {
            let pointer = entries
                .iter()
                .find(|entry| entry.tag == tag && entry.count == 1)?;
            let offset = u32::from_le_bytes(pointer.data.get(..4)?.try_into().ok()?) as usize;
            let sub = read_ifd(block, big, offset)?
                .into_iter()
                .filter(|entry| entry.tag != INTEROPERABILITY_IFD)
                .collect();
            Some((tag, sub))
        })
        .collect()
}

/// Appends an IFD for `entries` to `out`, followed by the values that do not fit in an entry. The IFD
/// starts on a word boundary, and its entries are sorted by tag, as TIFF requires. Offsets are taken
/// from the start of `out`. Returns the offset of the IFD.
pub fn append_ifd(out: &mut Vec<u8>, entries: &[Entry]) -> Result<u32, String> {
    if out.len() % 2 == 1 {
        out.push(0);
    }
    let mut sorted: Vec<&Entry> = entries.iter().collect();
    sorted.sort_by_key(|entry| entry.tag);
    let ifd_at = out.len();
    let ifd_len = 2 + sorted.len() * ENTRY_LEN + 4;
    let spill_base = ifd_at + ifd_len;
    let mut ifd = Vec::with_capacity(ifd_len);
    let mut spill = Vec::new();
    ifd.extend_from_slice(&(sorted.len() as u16).to_le_bytes());
    for entry in sorted {
        ifd.extend_from_slice(&entry.tag.to_le_bytes());
        ifd.extend_from_slice(&entry.kind.to_le_bytes());
        ifd.extend_from_slice(&entry.count.to_le_bytes());
        let mut field = [0u8; 4];
        if entry.data.len() <= 4 {
            field[..entry.data.len()].copy_from_slice(&entry.data);
        } else {
            let offset = spill_base + spill.len();
            field = u32::try_from(offset)
                .map_err(|_| "TIFF data is too large".to_string())?
                .to_le_bytes();
            spill.extend_from_slice(&entry.data);
            if spill.len() % 2 == 1 {
                spill.push(0);
            }
        }
        ifd.extend_from_slice(&field);
    }
    ifd.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&ifd);
    out.extend_from_slice(&spill);
    u32::try_from(ifd_at).map_err(|_| "TIFF data is too large".to_string())
}

/// Appends IFD0 for `entries` and then each sub-IFD in `subs`. Every sub-IFD is written first, and IFD0
/// gets a LONG pointer to it under the sub-IFD's tag. Returns the offset of IFD0.
pub fn append_ifd_tree(
    out: &mut Vec<u8>,
    entries: &[Entry],
    subs: &[(u16, Vec<Entry>)],
) -> Result<u32, String> {
    let mut ifd0 = entries.to_vec();
    for (tag, sub) in subs {
        let offset = append_ifd(out, sub)?;
        ifd0.push(Entry::long(*tag, offset));
    }
    append_ifd(out, &ifd0)
}

/// A little-endian EXIF block whose IFD0 holds `entries` and whose sub-IFDs are `subs`: the TIFF structure
/// of 07 FMT-NAT-07, without the `Exif\0\0` prefix.
pub fn exif_block(entries: &[Entry], subs: &[(u16, Vec<Entry>)]) -> Result<Vec<u8>, String> {
    let mut out = b"II*\0".to_vec();
    out.extend_from_slice(&[0; 4]);
    let ifd = append_ifd_tree(&mut out, entries, subs)?;
    out[4..HEADER_LEN].copy_from_slice(&ifd.to_le_bytes());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exif_block_round_trips_entries_in_either_byte_order() {
        let entries = vec![
            Entry::shorts(0x0102, &[8, 8, 8]),
            Entry::new(0x010e, 2, 6, b"hello\0".to_vec()),
            Entry::rational(0x011a, 72, 1),
        ];
        let block = exif_block(&entries, &[]).unwrap();
        assert_eq!(ifd0_entries(&block).unwrap(), {
            let mut sorted = entries.clone();
            sorted.sort_by_key(|entry| entry.tag);
            sorted
        });

        let mut big = vec![b'M', b'M', 0, 42, 0, 0, 0, 8, 0, 1];
        big.extend_from_slice(&[0x01, 0x02, 0, 3, 0, 0, 0, 1, 0, 7, 0, 0]);
        big.extend_from_slice(&[0, 0, 0, 0]);
        let parsed = ifd0_entries(&big).unwrap();
        assert_eq!(parsed, vec![Entry::short(0x0102, 7)]);
    }

    #[test]
    fn sub_ifds_round_trip_and_drop_the_interoperability_pointer() {
        let exif = vec![
            Entry::new(0x9003, 2, 20, b"2026:10:13 10:00:00\0".to_vec()),
            Entry::long(INTEROPERABILITY_IFD, 0),
        ];
        let gps = vec![Entry::new(0x0001, 2, 2, b"N\0".to_vec())];
        let block = exif_block(
            &[Entry::new(0x013b, 2, 6, b"Ada\0\0\0".to_vec())],
            &[(EXIF_IFD, exif), (GPS_IFD, gps.clone())],
        )
        .unwrap();
        let subs = sub_ifds(&block);
        assert_eq!(subs.len(), 2);
        assert_eq!(subs[0].0, EXIF_IFD);
        assert_eq!(
            subs[0].1,
            vec![Entry::new(0x9003, 2, 20, b"2026:10:13 10:00:00\0".to_vec())]
        );
        assert_eq!(subs[1], (GPS_IFD, gps));
        let tags: Vec<u16> = ifd0_entries(&block)
            .unwrap()
            .iter()
            .map(|entry| entry.tag)
            .collect();
        assert_eq!(tags, vec![0x013b, EXIF_IFD, GPS_IFD]);
    }

    #[test]
    fn malformed_blocks_are_rejected() {
        assert_eq!(ifd0_entries(b"XX"), None);
        assert_eq!(ifd0_entries(&[b'I', b'I', 41, 0, 8, 0, 0, 0]), None);
        let truncated = [b'I', b'I', 42, 0, 8, 0, 0, 0, 5, 0];
        assert_eq!(ifd0_entries(&truncated), None);
        assert!(sub_ifds(&truncated).is_empty());
    }
}
