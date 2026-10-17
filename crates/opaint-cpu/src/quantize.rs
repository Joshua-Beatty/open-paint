//! 8-bit palette quantization (FMT-QNT-01 step 5, FMT-OPT-PNG-01 "Quantization algorithm").
//!
//! The caller prepares straight RGBA8 pixels (FMT-QNT-03). When `transparent_entry` is set, a pixel
//! with alpha 0 is transparent: it stays out of the palette and its index is not used. The palette
//! is built from the other pixels with Median Cut or Octree and holds at most `capacity` colors. The
//! caller adds any transparent entry itself. Each pixel then takes its nearest palette color, with
//! Floyd-Steinberg error diffusion scaled by `dithering / 8` (0 means no dithering).

use std::cmp::Reverse;
use std::collections::HashMap;

/// The palette algorithms of FMT-OPT-PNG-01.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Algorithm {
    /// Splits the box that holds the most pixels at the median of its widest channel.
    MedianCut,
    /// Inserts the colors into an RGB octree and merges the deepest nodes until the palette fits.
    Octree,
}

impl TryFrom<u8> for Algorithm {
    type Error = u8;

    fn try_from(id: u8) -> Result<Self, u8> {
        match id {
            0 => Ok(Self::MedianCut),
            1 => Ok(Self::Octree),
            other => Err(other),
        }
    }
}

/// One quantization request. `rgba` holds `width * height` straight RGBA8 pixels.
pub struct Request<'a> {
    pub rgba: &'a [u8],
    pub width: usize,
    pub height: usize,
    /// The most palette entries the result may hold, from 2 to 256.
    pub capacity: usize,
    pub transparent_entry: bool,
    pub algorithm: Algorithm,
    /// Dithering level, from 0 (none) to 8 (strongest).
    pub dithering: u8,
}

/// The palette and one palette index per pixel, row by row. Transparent pixels hold index 0.
#[derive(Debug, PartialEq, Eq)]
pub struct Quantized {
    /// RGB triples, one per palette entry.
    pub palette: Vec<u8>,
    pub indices: Vec<u8>,
}

const MIN_CAPACITY: usize = 2;
const MAX_CAPACITY: usize = 256;
const MAX_DITHERING: u8 = 8;
const LEVELS: usize = 8;

type Color = [u8; 3];

/// Builds the palette and maps every pixel to it (see the module docs).
pub fn quantize(request: &Request) -> Result<Quantized, String> {
    let pixels = request
        .width
        .checked_mul(request.height)
        .ok_or_else(|| "Quantization image is too large.".to_string())?;
    if pixels == 0 || request.rgba.len() != pixels * 4 {
        return Err("Quantization pixels do not match the image size.".to_string());
    }
    if !(MIN_CAPACITY..=MAX_CAPACITY).contains(&request.capacity) {
        return Err(format!(
            "Palette capacity {} is outside 2 to 256.",
            request.capacity
        ));
    }
    if request.dithering > MAX_DITHERING {
        return Err(format!(
            "Dithering level {} is outside 0 to 8.",
            request.dithering
        ));
    }
    let colors = histogram(request.rgba, request.transparent_entry);
    let palette = match request.algorithm {
        Algorithm::MedianCut => median_cut(&colors, request.capacity),
        Algorithm::Octree => octree(&colors, request.capacity),
    };
    let indices = map_pixels(request, &palette);
    Ok(Quantized {
        palette: palette.iter().flatten().copied().collect(),
        indices,
    })
}

/// The distinct colors of the pixels that take part in the palette, with their pixel counts. The
/// list is sorted by color, so every run builds the same palette.
fn histogram(rgba: &[u8], transparent_entry: bool) -> Vec<(Color, u64)> {
    let mut counts: HashMap<Color, u64> = HashMap::new();
    for &[r, g, b, a] in rgba.as_chunks::<4>().0 {
        if transparent_entry && a == 0 {
            continue;
        }
        *counts.entry([r, g, b]).or_insert(0) += 1;
    }
    let mut colors: Vec<(Color, u64)> = counts.into_iter().collect();
    colors.sort_unstable();
    colors
}

/// Median Cut: starts with one box holding every color. Each step splits the box with the most
/// pixels (among boxes with two or more colors) at the median of its widest channel, until there
/// are `capacity` boxes. Each box's mean color becomes a palette entry.
fn median_cut(colors: &[(Color, u64)], capacity: usize) -> Vec<Color> {
    let mut entries = colors.to_vec();
    let mut boxes: Vec<(usize, usize)> = vec![(0, entries.len())];
    while boxes.len() < capacity {
        let pick = boxes
            .iter()
            .enumerate()
            .filter(|(_, (start, end))| end - start > 1)
            .max_by_key(|(index, (start, end))| (weight(&entries[*start..*end]), Reverse(*index)))
            .map(|(index, &(start, end))| (index, start, end));
        let Some((index, start, end)) = pick else {
            break;
        };
        let channel = widest_channel(&entries[start..end]);
        let slice = &mut entries[start..end];
        slice.sort_unstable_by_key(|(color, _)| (color[channel], *color));
        let total = weight(slice);
        let mut seen = 0u64;
        let mut split = start + 1;
        for (offset, (_, count)) in slice[..slice.len() - 1].iter().enumerate() {
            seen += *count;
            if seen * 2 >= total {
                split = start + offset + 1;
                break;
            }
        }
        boxes[index] = (start, split);
        boxes.push((split, end));
    }
    boxes
        .iter()
        .filter(|(start, end)| start < end)
        .map(|&(start, end)| weighted_mean(&entries[start..end]))
        .collect()
}

fn weight(entries: &[(Color, u64)]) -> u64 {
    entries.iter().map(|(_, count)| count).sum()
}

/// The channel (0 red, 1 green, 2 blue) with the widest range. Ties go to the lowest channel.
fn widest_channel(entries: &[(Color, u64)]) -> usize {
    let mut low = [u8::MAX; 3];
    let mut high = [u8::MIN; 3];
    for (color, _) in entries {
        for ((lo, hi), value) in low.iter_mut().zip(high.iter_mut()).zip(color) {
            *lo = (*lo).min(*value);
            *hi = (*hi).max(*value);
        }
    }
    (0..3)
        .max_by_key(|&channel| (high[channel] - low[channel], Reverse(channel)))
        .unwrap_or(0)
}

fn weighted_mean(entries: &[(Color, u64)]) -> Color {
    let mut sums = [0u64; 3];
    let mut total = 0u64;
    for (color, count) in entries {
        total += *count;
        for (sum, value) in sums.iter_mut().zip(color) {
            *sum += u64::from(*value) * *count;
        }
    }
    round_mean(sums, total)
}

/// `sums / count`, rounded half up, for `count` > 0.
fn round_mean(sums: [u64; 3], count: u64) -> Color {
    sums.map(|sum| ((sum + count / 2) / count) as u8)
}

/// One node of the octree. Child slots hold arena indices, where 0 (the root) means no child.
#[derive(Clone, Copy, Default)]
struct Node {
    children: [u32; 8],
    child_count: u8,
    leaf: bool,
    count: u64,
    sums: [u64; 3],
}

/// The octree of RGB bits. Level `L` of the tree decides bit `7 - L` of each channel. A leaf is a
/// level-8 node, or a node that `reduce_one` merged, and it holds the mean of its pixels.
struct Octree {
    nodes: Vec<Node>,
    free: Vec<u32>,
    /// Nodes that have children, per level. These are the merge candidates.
    reducible: [Vec<u32>; LEVELS],
    leaves: usize,
    capacity: usize,
}

impl Octree {
    fn new(capacity: usize) -> Self {
        Self {
            nodes: vec![Node::default()],
            free: Vec::new(),
            reducible: Default::default(),
            leaves: 0,
            capacity,
        }
    }

    /// Adds `weight` pixels of `color`, then merges nodes while the palette has too many leaves.
    fn insert(&mut self, color: Color, weight: u64) {
        let mut node = 0;
        let mut level = 0;
        while !self.nodes[node].leaf {
            let shift = 7 - level;
            let slot = color.iter().fold(0, |slot, &value| {
                (slot << 1) | usize::from((value >> shift) & 1)
            });
            let child = match self.nodes[node].children[slot] {
                0 => self.add_child(node, slot, level),
                existing => existing as usize,
            };
            node = child;
            level += 1;
        }
        let target = &mut self.nodes[node];
        target.count += weight;
        for (sum, &value) in target.sums.iter_mut().zip(&color) {
            *sum += weight * u64::from(value);
        }
        while self.leaves > self.capacity && self.reduce_one() {}
    }

    fn add_child(&mut self, parent: usize, slot: usize, level: usize) -> usize {
        let leaf = level + 1 == LEVELS;
        let fresh = Node {
            leaf,
            ..Node::default()
        };
        let index = match self.free.pop() {
            Some(reused) => {
                self.nodes[reused as usize] = fresh;
                reused as usize
            }
            None => {
                self.nodes.push(fresh);
                self.nodes.len() - 1
            }
        };
        if leaf {
            self.leaves += 1;
        }
        if self.nodes[parent].child_count == 0 {
            self.reducible[level].push(parent as u32);
        }
        self.nodes[parent].children[slot] = index as u32;
        self.nodes[parent].child_count += 1;
        index
    }

    /// Merges the children of the deepest node that has children into that node, which becomes a
    /// leaf. The children are always leaves, because deeper levels are merged first. Returns false
    /// when there is nothing left to merge.
    fn reduce_one(&mut self) -> bool {
        let Some(level) = (0..LEVELS)
            .rev()
            .find(|&level| !self.reducible[level].is_empty())
        else {
            return false;
        };
        let Some(parent) = self.reducible[level].pop() else {
            return false;
        };
        let parent = parent as usize;
        let children = self.nodes[parent].children;
        let mut count = 0u64;
        let mut sums = [0u64; 3];
        for child in children.into_iter().filter(|&child| child != 0) {
            let node = self.nodes[child as usize];
            debug_assert!(node.leaf, "octree children are merged before their parents");
            count += node.count;
            for (sum, value) in sums.iter_mut().zip(node.sums) {
                *sum += value;
            }
            self.free.push(child);
            self.leaves -= 1;
        }
        let node = &mut self.nodes[parent];
        node.leaf = true;
        node.child_count = 0;
        node.children = [0; 8];
        node.count = count;
        node.sums = sums;
        self.leaves += 1;
        true
    }

    fn palette(&self) -> Vec<(Color, u64)> {
        let mut out = Vec::new();
        self.collect(0, &mut out);
        out
    }

    fn collect(&self, index: usize, out: &mut Vec<(Color, u64)>) {
        let node = &self.nodes[index];
        if node.leaf {
            if node.count > 0 {
                out.push((round_mean(node.sums, node.count), node.count));
            }
            return;
        }
        for &child in node.children.iter().filter(|&&child| child != 0) {
            self.collect(child as usize, out);
        }
    }
}

/// Octree: inserts every color (sorted, so the result is deterministic) and merges as it goes, which
/// keeps the number of nodes bounded. The tree keeps at least 8 leaves, one per top-level octant:
/// below that, merging the root would collapse the whole palette into one color. Any extra entries
/// are then merged by weight until `capacity` remain.
fn octree(colors: &[(Color, u64)], capacity: usize) -> Vec<Color> {
    let mut tree = Octree::new(capacity.max(8));
    for &(color, count) in colors {
        tree.insert(color, count);
    }
    let mut entries = tree.palette();
    merge_closest(&mut entries, capacity);
    entries.into_iter().map(|(color, _)| color).collect()
}

/// Merges the two palette entries whose merge adds the least squared error, until `capacity` remain.
fn merge_closest(entries: &mut Vec<(Color, u64)>, capacity: usize) {
    while entries.len() > capacity {
        let mut best = (u128::MAX, 0, 1);
        for (i, &a) in entries.iter().enumerate() {
            for (j, &b) in entries.iter().enumerate().skip(i + 1) {
                let cost = merge_cost(a, b);
                if cost < best.0 {
                    best = (cost, i, j);
                }
            }
        }
        let (_, i, j) = best;
        let (color, count) = entries.remove(j);
        let total = entries[i].1 + count;
        let mean = weighted_mean(&[entries[i], (color, count)]);
        entries[i] = (mean, total);
    }
}

/// The growth of squared error when two entries merge: `na * nb / (na + nb) * distance²`.
fn merge_cost(a: (Color, u64), b: (Color, u64)) -> u128 {
    let distance: u128 = a
        .0
        .iter()
        .zip(b.0)
        .map(|(x, y)| {
            let delta = u128::from(x.abs_diff(y));
            delta * delta
        })
        .sum();
    let (na, nb) = (u128::from(a.1), u128::from(b.1));
    na * nb * distance / (na + nb)
}

/// Maps every pixel to its nearest palette color. The error of each pixel is spread to the
/// unvisited neighbours with the Floyd-Steinberg weights, scaled by `dithering / 8`. Transparent
/// pixels are skipped and carry no error.
fn map_pixels(request: &Request, palette: &[Color]) -> Vec<u8> {
    let width = request.width;
    let mut indices = vec![0u8; width * request.height];
    if palette.is_empty() {
        return indices;
    }
    let scale = f32::from(request.dithering) / f32::from(MAX_DITHERING);
    let mut nearest_for: HashMap<Color, u8> = HashMap::new();
    // The error carried into the current row and into the next one.
    let mut row = vec![[0f32; 3]; width];
    let mut next_row = vec![[0f32; 3]; width];
    for y in 0..request.height {
        for x in 0..width {
            let pixel = y * width + x;
            let rgba = &request.rgba[pixel * 4..pixel * 4 + 4];
            if request.transparent_entry && rgba[3] == 0 {
                continue;
            }
            let target: [f32; 3] = std::array::from_fn(|channel| {
                (f32::from(rgba[channel]) + row[x][channel]).clamp(0.0, 255.0)
            });
            let color: Color = target.map(|value| (value + 0.5) as u8);
            let index = *nearest_for
                .entry(color)
                .or_insert_with(|| nearest(palette, color));
            indices[pixel] = index;
            let chosen = palette[usize::from(index)];
            let error: [f32; 3] = std::array::from_fn(|channel| {
                (target[channel] - f32::from(chosen[channel])) * scale
            });
            if x + 1 < width {
                spread(&mut row[x + 1], error, 7.0 / 16.0);
            }
            if x > 0 {
                spread(&mut next_row[x - 1], error, 3.0 / 16.0);
            }
            spread(&mut next_row[x], error, 5.0 / 16.0);
            if x + 1 < width {
                spread(&mut next_row[x + 1], error, 1.0 / 16.0);
            }
        }
        std::mem::swap(&mut row, &mut next_row);
        next_row.fill([0.0; 3]);
    }
    indices
}

fn spread(cell: &mut [f32; 3], error: [f32; 3], weight: f32) {
    for (value, error) in cell.iter_mut().zip(error) {
        *value += error * weight;
    }
}

/// The index of the palette entry closest to `color` (squared RGB distance). Ties go to the lower
/// index.
fn nearest(palette: &[Color], color: Color) -> u8 {
    let distance = |entry: &Color| -> u32 {
        entry
            .iter()
            .zip(color)
            .map(|(a, b)| {
                let delta = u32::from(a.abs_diff(b));
                delta * delta
            })
            .sum()
    };
    palette
        .iter()
        .enumerate()
        .min_by_key(|(index, entry)| (distance(entry), *index))
        .map_or(0, |(index, _)| index as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A seeded linear congruential generator, so the random images are the same on every run.
    fn random_pixels(seed: u32, count: usize) -> Vec<u8> {
        let mut state = seed;
        (0..count)
            .flat_map(|_| {
                let mut pixel = [0u8; 4];
                for value in &mut pixel {
                    state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    *value = (state >> 24) as u8;
                }
                pixel[3] = 255;
                pixel
            })
            .collect()
    }

    fn request(rgba: &[u8], width: usize, height: usize) -> Request<'_> {
        Request {
            rgba,
            width,
            height,
            capacity: 16,
            transparent_entry: false,
            algorithm: Algorithm::Octree,
            dithering: 0,
        }
    }

    fn palette_colors(palette: &[u8]) -> Vec<Color> {
        palette.as_chunks::<3>().0.to_vec()
    }

    fn colors_of(rgba: &[u8]) -> Vec<Color> {
        rgba.as_chunks::<4>()
            .0
            .iter()
            .map(|p| [p[0], p[1], p[2]])
            .collect()
    }

    #[test]
    fn algorithm_ids_map_to_median_cut_and_octree() {
        assert_eq!(Algorithm::try_from(0), Ok(Algorithm::MedianCut));
        assert_eq!(Algorithm::try_from(1), Ok(Algorithm::Octree));
        assert_eq!(Algorithm::try_from(2), Err(2));
    }

    #[test]
    fn exact_palette_when_the_colors_fit() {
        let colors: [Color; 4] = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [10, 20, 250]];
        let rgba: Vec<u8> = (0..64)
            .flat_map(|i| {
                let c = colors[(i * 7 + i / 3) % 4];
                [c[0], c[1], c[2], 255]
            })
            .collect();
        for algorithm in [Algorithm::MedianCut, Algorithm::Octree] {
            let mut req = request(&rgba, 8, 8);
            req.algorithm = algorithm;
            req.dithering = 8;
            let out = quantize(&req).unwrap();
            let palette = palette_colors(&out.palette);
            assert_eq!(palette.len(), 4, "{algorithm:?}");
            let mapped: Vec<Color> = out
                .indices
                .iter()
                .map(|&i| palette[usize::from(i)])
                .collect();
            assert_eq!(mapped, colors_of(&rgba), "{algorithm:?} maps exactly");
        }
    }

    #[test]
    fn palette_never_exceeds_the_capacity() {
        let rgba = random_pixels(7, 24 * 24);
        for algorithm in [Algorithm::MedianCut, Algorithm::Octree] {
            for capacity in [2, 3, 16, 255, 256] {
                let mut req = request(&rgba, 24, 24);
                req.algorithm = algorithm;
                req.capacity = capacity;
                req.dithering = 7;
                let out = quantize(&req).unwrap();
                let entries = out.palette.len() / 3;
                assert!(
                    (1..=capacity).contains(&entries),
                    "{algorithm:?} capacity {capacity} gave {entries}"
                );
                assert!(out.indices.iter().all(|&i| usize::from(i) < entries));
            }
        }
    }

    #[test]
    fn octree_and_median_cut_find_the_two_clusters() {
        let mut rgba = Vec::new();
        for i in 0..64u8 {
            let base = if i % 2 == 0 { 10 } else { 240 };
            rgba.extend_from_slice(&[base + (i % 3), base, base + (i % 5), 255]);
        }
        for algorithm in [Algorithm::MedianCut, Algorithm::Octree] {
            let mut req = request(&rgba, 8, 8);
            req.algorithm = algorithm;
            req.capacity = 2;
            let out = quantize(&req).unwrap();
            let mut palette = palette_colors(&out.palette);
            palette.sort_unstable();
            assert_eq!(palette.len(), 2, "{algorithm:?}");
            for (entry, center) in palette.iter().zip([10u8, 240]) {
                for channel in entry {
                    assert!(
                        channel.abs_diff(center) <= 3,
                        "{algorithm:?} entry {entry:?} is near {center}"
                    );
                }
            }
        }
    }

    #[test]
    fn octree_keeps_several_colors_for_small_palettes() {
        let mut rgba = Vec::new();
        for y in 0..16u8 {
            for x in 0..16u8 {
                rgba.extend_from_slice(&[x * 16, y * 16, (x + y) * 8, 255]);
            }
        }
        for capacity in 2..=7 {
            let mut req = request(&rgba, 16, 16);
            req.algorithm = Algorithm::Octree;
            req.capacity = capacity;
            let out = quantize(&req).unwrap();
            let entries = palette_colors(&out.palette).len();
            assert!((2..=capacity).contains(&entries), "capacity {capacity} gave {entries}");
        }
    }

    #[test]
    fn transparent_pixels_stay_out_of_the_palette() {
        let rgba = [
            0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 255, 0, 255, 0, 0, 0, 0, 0,
        ];
        for algorithm in [Algorithm::MedianCut, Algorithm::Octree] {
            let mut req = request(&rgba, 4, 2);
            req.algorithm = algorithm;
            req.transparent_entry = true;
            req.capacity = 255;
            let out = quantize(&req).unwrap();
            let mut palette = palette_colors(&out.palette);
            palette.sort_unstable();
            assert_eq!(palette, vec![[0, 0, 0], [255, 255, 255]], "{algorithm:?}");
            assert_eq!(out.indices[2], 0, "transparent pixels hold index 0");
        }
    }

    #[test]
    fn dithering_level_zero_maps_to_the_nearest_color_only() {
        let rgba: Vec<u8> = [128u8, 128, 128, 255].repeat(16);
        let palette: [Color; 2] = [[0, 0, 0], [255, 255, 255]];
        let none = map_pixels(&request(&rgba, 4, 4), &palette);
        assert!(none.iter().all(|&i| i == 1), "128 is nearer 255");
    }

    #[test]
    fn strong_dithering_mixes_the_palette_on_a_flat_tone() {
        let rgba: Vec<u8> = [128u8, 128, 128, 255].repeat(32 * 32);
        let palette: [Color; 2] = [[0, 0, 0], [255, 255, 255]];
        let mut req = request(&rgba, 32, 32);
        req.dithering = 8;
        let indices = map_pixels(&req, &palette);
        let lit = indices.iter().filter(|&&i| i == 1).count();
        let total = indices.len();
        assert!(
            (total * 2 / 5..=total * 3 / 5).contains(&lit),
            "about half the pixels are light, got {lit} of {total}"
        );
    }

    #[test]
    fn quantization_is_deterministic() {
        let rgba = random_pixels(11, 20 * 20);
        for algorithm in [Algorithm::MedianCut, Algorithm::Octree] {
            let mut req = request(&rgba, 20, 20);
            req.algorithm = algorithm;
            req.dithering = 5;
            assert_eq!(quantize(&req).unwrap(), quantize(&req).unwrap());
        }
    }

    #[test]
    fn rejects_bad_requests() {
        let rgba = random_pixels(3, 4);
        let mut req = request(&rgba, 2, 2);
        req.capacity = 1;
        assert!(quantize(&req).is_err());
        req.capacity = 257;
        assert!(quantize(&req).is_err());
        req.capacity = 16;
        req.dithering = 9;
        assert!(quantize(&req).is_err());
        assert!(quantize(&request(&rgba, 3, 2)).is_err());
        assert!(quantize(&request(&rgba, 0, 2)).is_err());
    }
}
