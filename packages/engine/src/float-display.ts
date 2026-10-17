import { intersectRects, type Rect, rect, type Size } from "@openpaint/document";
import { activeLayers, type CompositeDocument, type CompositeLayer } from "./composite";
import { compositeCpu } from "./composite-cpu";
import { BLEND_WGSL } from "./composite-wgsl";
import { lanczos3AxisTaps } from "./cpu";
import {
  coveredExtent,
  DISPLAY_TILE_SIZE,
  type DisplayTile,
  type TileRef,
  tileEdge,
  tileKey,
  tilesAcross,
} from "./display-tiles";
import type { FloatLayer } from "./document-sync";
import { BufferUsage, TextureUsage } from "./gpu-device";
import { FLOAT_COMPOSE, FloatGpu, floatFits } from "./gpu-float";
import { timedStage } from "./perf";
import { type ComputeShader, computePipeline } from "./pipeline-cache";
import type { EngineStatus } from "./protocol";

/** DOC-BLD-01 Normal. */
const NORMAL = 0;
/** Values per output pixel of the Lanczos-3 tap table (`lanczos3_axis_taps`). */
const TAP_STRIDE = 14;
const WORKGROUP = 8;

/**
 * Whether engine v1 can show floating content over the layer at `index` of `layers`: every visible
 * layer above it blends Normally, so the layers above composite into one image that goes over the
 * float (`FloatDisplay`). Engine v2 composites every layer on the GPU and shows any stack.
 */
export function floatStackSupported(
  layers: readonly { readonly visible: boolean; readonly opacity: number; readonly mode: number }[],
  index: number,
): boolean {
  return layers
    .slice(index + 1)
    .every((layer) => !layer.visible || layer.opacity === 0 || layer.mode === NORMAL);
}

/**
 * Whether the running engine can draw a floating session (TL-MOVE-PIX-01) instead of the page
 * writing its previews into the layer: it runs on WebGPU, its device holds the content and the
 * region (`floatFits`, the image grown to 256 px as the region at most), and on engine v1 the
 * layers above blend Normally.
 */
export function engineShowsFloat(
  status: Pick<EngineStatus, "backend" | "engine" | "adapter">,
  layers: readonly { readonly visible: boolean; readonly opacity: number; readonly mode: number }[],
  index: number,
  content: Size,
  image: Size,
): boolean {
  if (status.backend !== "webgpu" || index < 0) return false;
  const limits = status.adapter?.limits;
  const align = (value: number) => Math.ceil(value / 256) * 256;
  const region = { width: align(image.width), height: align(image.height) };
  if (limits !== undefined && !floatFits(limits, content, region)) return false;
  return status.engine === "v2" || floatStackSupported(layers, index);
}

const PACKING_WGSL = /* wgsl */ `
fn unpack(word: u32) -> vec4u {
  return vec4u(word & 255u, (word >> 8u) & 255u, (word >> 16u) & 255u, word >> 24u);
}

fn pack(v: vec4u) -> u32 {
  return v.x | (v.y << 8u) | (v.z << 16u) | (v.w << 24u);
}
`;

/**
 * Which pixels of a level come from the display tile's own bytes (`Params.flags`): on a level
 * below the shown one none do, every pixel is computed from the layers; on the shown level the
 * pixels the float does not change do, except in a stale tile, where the ones the layer copies
 * reach (`v`) are computed, so a tile the display has not rebuilt yet shows the current layers.
 */
const FLAG_UNDER = 1;
const FLAG_OVER = 2;
const FLAG_BELOW = 4;

/** Whether the pixel at `q` (level pixels) keeps the display tile's bytes (see `FLAG_BELOW`). */
const KEEPS_WGSL = /* wgsl */ `
fn keeps(moved: u32, q: vec2u, tile: vec2u) -> bool {
  if (moved != 0u || (p.flags & ${FLAG_BELOW}u) != 0u) {
    return false;
  }
  if (fresh[tile.y * p.tiles_w + tile.x] != 0u) {
    return true;
  }
  return !(q.x >= p.v_x && q.y >= p.v_y && q.x < p.v_x + p.v_w && q.y < p.v_y + p.v_h);
}
`;

/**
 * Level 0 of the display over the affected tiles, as `renderBase` builds it: the layers under the
 * float's (one composite), its layer, with the float in place of its stored pixels where they
 * differ, in its blend mode and opacity, and the layers above (one composite, Normal) blended with
 * the WGSL twin of the reference and premultiplied as `premultiply_rgba8` does. The layers are
 * copied over `c`; pixels the float changes are marked, and pixels that keep the display tile's
 * bytes (`keeps`) are not computed. Pixels past the image repeat its last column and row
 * (`padTile`).
 */
const LEVEL0_WGSL = /* wgsl */ `
struct Params {
  q_x: u32, q_y: u32, q_w: u32, q_h: u32,
  r_x: u32, r_y: u32, r_w: u32, r_h: u32,
  c_x: u32, c_y: u32, c_w: u32, c_h: u32,
  v_x: u32, v_y: u32, v_w: u32, v_h: u32,
  doc_w: u32, doc_h: u32, mode: u32, opacity: u32,
  flags: u32, tiles_w: u32, pad0: u32, pad1: u32,
}

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var float_tex: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> stored: array<u32>;
@group(0) @binding(3) var<storage, read> under: array<u32>;
@group(0) @binding(4) var<storage, read> over: array<u32>;
@group(0) @binding(5) var<storage, read> fixed_px: array<u32>;
@group(0) @binding(6) var<storage, read_write> out: array<u32>;
@group(0) @binding(7) var<storage, read_write> changed: array<u32>;
@group(0) @binding(8) var<storage, read> fresh: array<u32>;

${BLEND_WGSL}
${PACKING_WGSL}
${KEEPS_WGSL}

fn premultiply(d: vec4u) -> vec4u {
  if (d.w == 255u) {
    return d;
  }
  return vec4u((d.xyz * d.w + vec3u(127u)) / 255u, d.w);
}

@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP})
fn level0(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.q_w || id.y >= p.q_h) {
    return;
  }
  let i = id.y * p.q_w + id.x;
  let q = min(vec2u(p.q_x + id.x, p.q_y + id.y), vec2u(p.doc_w - 1u, p.doc_h - 1u));
  let tile = id.xy / ${DISPLAY_TILE_SIZE}u;
  var word = 0u;
  var moved = 0u;
  if (q.x >= p.c_x && q.y >= p.c_y && q.x < p.c_x + p.c_w && q.y < p.c_y + p.c_h) {
    let j = (q.y - p.c_y) * p.c_w + (q.x - p.c_x);
    var layer = unpack(stored[j]);
    if (q.x >= p.r_x && q.y >= p.r_y && q.x < p.r_x + p.r_w && q.y < p.r_y + p.r_h) {
      let f = vec4u(round(textureLoad(float_tex, vec2i(q - vec2u(p.r_x, p.r_y)), 0) * 255.0));
      if (any(f != layer)) {
        layer = f;
        moved = 1u;
      }
    }
    if (keeps(moved, q, tile)) {
      word = fixed_px[i];
    } else {
      var d = vec4u(0u);
      if ((p.flags & ${FLAG_UNDER}u) != 0u) {
        d = unpack(under[j]);
      }
      d = composite_pixel(d, layer, p.mode, p.opacity);
      if ((p.flags & ${FLAG_OVER}u) != 0u) {
        d = composite_pixel(d, unpack(over[j]), 0u, 255u);
      }
      word = pack(premultiply(d));
    }
  } else if ((p.flags & ${FLAG_BELOW}u) == 0u) {
    word = fixed_px[i];
  }
  out[i] = word;
  changed[i] = moved;
}
`;

/**
 * One display mip level over the affected tiles from the level below, as the final display tiles
 * are built (`downsample` with Lanczos-3): each tile from its 2x2 children only, the block padded
 * past the image's covered pixels, the taps of `resample_lanczos3_rgba8` applied in its order,
 * horizontal then vertical, with color clamped to alpha. On the shown level a pixel none of whose
 * taps changed keeps the display tile's own bytes (`keeps`), so it is exactly what the display
 * shows.
 */
const LANCZOS_WGSL = /* wgsl */ `
struct Params {
  q_x: u32, q_y: u32, q_w: u32, q_h: u32,
  p_x: u32, p_y: u32, p_w: u32, p_h: u32,
  cover_pw: u32, cover_ph: u32, cover_w: u32, cover_h: u32,
  v_x: u32, v_y: u32, v_w: u32, v_h: u32,
  flags: u32, tiles_w: u32, pad0: u32, pad1: u32,
}

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> taps: array<f32>;
@group(0) @binding(2) var<storage, read> prev: array<u32>;
@group(0) @binding(3) var<storage, read> prev_changed: array<u32>;
@group(0) @binding(4) var<storage, read> fixed_px: array<u32>;
@group(0) @binding(5) var<storage, read_write> out: array<u32>;
@group(0) @binding(6) var<storage, read_write> changed: array<u32>;
// The horizontal pass's result: the level's columns over the rows below, as the reference keeps it.
@group(0) @binding(7) var<storage, read_write> rows: array<vec4f>;
@group(0) @binding(8) var<storage, read_write> rows_changed: array<u32>;
@group(0) @binding(9) var<storage, read> fresh: array<u32>;

${PACKING_WGSL}
${KEEPS_WGSL}

fn to_byte(v: f32) -> u32 {
  return u32(clamp(floor(v + 0.5), 0.0, 255.0));
}

// One row of the level below, resampled across: column t.x of the level (past the covered pixels a
// tile repeats its last ones, padTile), from its block's taps, the block padded past the covered
// pixels below.
@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP})
fn horizontal(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.q_w || id.y >= p.p_h) {
    return;
  }
  let tx = min(p.q_x + id.x, p.cover_w - 1u);
  let yy = min(p.p_y + id.y, p.cover_ph - 1u);
  let bx = (tx / ${DISPLAY_TILE_SIZE}u) * ${2 * DISPLAY_TILE_SIZE}u;
  let ex = (tx % ${DISPLAY_TILE_SIZE}u) * ${TAP_STRIDE}u;
  let fx = u32(taps[ex]);
  let nx = u32(taps[ex + 1u]);
  var h = vec4f(0.0);
  var moved = 0u;
  for (var kx = 0u; kx < nx; kx++) {
    let xx = min(bx + fx + kx, p.cover_pw - 1u);
    let k = (yy - p.p_y) * p.p_w + (xx - p.p_x);
    h = h + taps[ex + 2u + kx] * vec4f(unpack(prev[k]));
    moved = moved | prev_changed[k];
  }
  let i = id.y * p.q_w + id.x;
  rows[i] = h;
  rows_changed[i] = moved;
}

@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP})
fn level(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.q_w || id.y >= p.q_h) {
    return;
  }
  let i = id.y * p.q_w + id.x;
  let ty = min(p.q_y + id.y, p.cover_h - 1u);
  let by = (ty / ${DISPLAY_TILE_SIZE}u) * ${2 * DISPLAY_TILE_SIZE}u;
  let ey = (ty % ${DISPLAY_TILE_SIZE}u) * ${TAP_STRIDE}u;
  let fy = u32(taps[ey]);
  let ny = u32(taps[ey + 1u]);
  var acc = vec4f(0.0);
  var moved = 0u;
  for (var ky = 0u; ky < ny; ky++) {
    let yy = min(by + fy + ky, p.cover_ph - 1u);
    let k = (yy - p.p_y) * p.q_w + id.x;
    acc = acc + taps[ey + 2u + ky] * rows[k];
    moved = moved | rows_changed[k];
  }
  let tx = min(p.q_x + id.x, p.cover_w - 1u);
  if (keeps(moved, vec2u(tx, ty), id.xy / ${DISPLAY_TILE_SIZE}u)) {
    out[i] = fixed_px[i];
  } else {
    let alpha = to_byte(acc.w);
    out[i] = pack(vec4u(min(to_byte(acc.x), alpha), min(to_byte(acc.y), alpha), min(to_byte(acc.z), alpha), alpha));
  }
  changed[i] = moved;
}
`;

/** One level of the affected tiles: their pixels (in level pixels) and the buffers over them. */
interface Level {
  readonly level: number;
  /** The tiles' rectangle in level pixels, a whole number of tiles. */
  readonly area: Rect;
  readonly out: GPUBuffer;
  readonly changed: GPUBuffer;
  /** The horizontal pass over the level below (levels above 0). */
  readonly rows?: GPUBuffer;
  readonly rowsChanged?: GPUBuffer;
}

/** The layers around the float over `copy`: its region and as far as the mip filter reads. */
interface Copies {
  readonly key: string;
  readonly copy: Rect;
  readonly stored: GPUBuffer;
  readonly under: GPUBuffer | undefined;
  readonly over: GPUBuffer | undefined;
}

/** The buffers of every level up to the shown one. */
interface Levels {
  readonly key: string;
  readonly levels: readonly Level[];
}

/** The shown level's display tiles as the display shows them, and which are up to date. */
interface ShownTiles {
  readonly key: string;
  readonly fixed: GPUBuffer;
  readonly fresh: GPUBuffer;
}

/** The display tiles the float shows in, at one level: a range of tiles `tx0..tx1`, `ty0..ty1`. */
interface TileRange {
  readonly tx0: number;
  readonly ty0: number;
  readonly tx1: number;
  readonly ty1: number;
}

/**
 * The display tile the display shows at `ref` now and whether it is up to date (not stale), or
 * undefined when it has none (`DisplayTileCache.peek`).
 */
export type DisplayTileSource = (
  ref: TileRef,
) => { readonly tile: DisplayTile; readonly fresh: boolean } | undefined;

/**
 * How far, in image pixels, the display's mip chain carries a pixel up to `level`: each Lanczos-3
 * halving reads up to 6 pixels of the level below on either side of a block's pixel.
 */
function mipReach(level: number): number {
  return 6 * 2 ** level;
}

function grown(r: Rect, by: number, size: Size): Rect {
  const x = Math.max(0, r.x - by);
  const y = Math.max(0, r.y - by);
  const right = Math.min(size.width, r.x + r.width + by);
  const bottom = Math.min(size.height, r.y + r.height + by);
  return rect(x, y, Math.max(0, right - x), Math.max(0, bottom - y));
}

const identities = new WeakMap<object, number>();
let nextIdentity = 0;

function identity(item: object): number {
  let id = identities.get(item);
  if (id === undefined) {
    nextIdentity += 1;
    id = nextIdentity;
    identities.set(item, id);
  }
  return id;
}

const LEVEL0: ComputeShader = {
  label: "float display level 0",
  code: LEVEL0_WGSL,
  entryPoint: "level0",
};
const LEVEL_ACROSS: ComputeShader = {
  label: "float display mip across",
  code: LANCZOS_WGSL,
  entryPoint: "horizontal",
};
const LEVEL_DOWN: ComputeShader = {
  label: "float display mip",
  code: LANCZOS_WGSL,
  entryPoint: "level",
};

/** Every pipeline `FloatDisplay` runs, to compile ahead of the first drag (`warmComputePipelines`). */
export const FLOAT_DISPLAY_SHADERS: readonly ComputeShader[] = [
  FLOAT_COMPOSE,
  LEVEL0,
  LEVEL_ACROSS,
  LEVEL_DOWN,
];

/**
 * Floating content on engine v1 (TL-MOVE-PIX-01), drawn through the display tiles themselves: the
 * visible tiles over the float's region are built again on the GPU, from level 0 up the mip chain
 * with twins of the tile builder's steps, and the presenter draws them in place of the cached
 * tiles with the same quads and sampling. The levels below the shown one are computed from copies
 * of the layers around the float, so no other display tiles are needed. On the shown level, pixels
 * the float does not change keep the display tile's bytes, so the image around the moved content
 * is exactly what the display shows; the moved content is what the tiles will show once the step
 * is recorded, within ±1. In a tile the display has not rebuilt since an edit (a stale one), the
 * pixels the copies reach show the current layers instead. Nothing is read back.
 */
export class FloatDisplay {
  readonly #device: GPUDevice;
  readonly #float: FloatGpu;
  readonly #taps: GPUBuffer;
  readonly #empty: GPUBuffer;
  #copies: Copies | undefined;
  #levels: Levels | undefined;
  #shownTiles: ShownTiles | undefined;
  /** Tile textures by tile key, reused from frame to frame. */
  readonly #textures = new Map<string, GPUTexture>();
  /** The tiles the last call drew, and what they show. */
  #drawn: { readonly key: string; readonly tiles: ReadonlyMap<string, GPUTexture> } | undefined;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#float = new FloatGpu(device);
    const taps = lanczos3AxisTaps(2 * DISPLAY_TILE_SIZE, DISPLAY_TILE_SIZE);
    this.#taps = device.createBuffer({
      label: "display mip taps",
      size: taps.byteLength,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.#taps, 0, taps as Float32Array<ArrayBuffer>);
    this.#empty = device.createBuffer({
      label: "float no layers",
      size: 16,
      usage: BufferUsage.STORAGE,
    });
  }

  get #level0(): GPUComputePipeline {
    return computePipeline(this.#device, LEVEL0);
  }

  get #levelH(): GPUComputePipeline {
    return computePipeline(this.#device, LEVEL_ACROSS);
  }

  get #levelN(): GPUComputePipeline {
    return computePipeline(this.#device, LEVEL_DOWN);
  }

  /** Whether this device can show `float` over `doc`'s stack. */
  supports(doc: CompositeDocument, float: FloatLayer): boolean {
    return (
      floatFits(this.#device.limits, float.content, float.base.region) &&
      float.index < doc.layers.length &&
      floatStackSupported(doc.layers, float.index)
    );
  }

  /**
   * The display tiles at `level` among `visible` that show `float` over `doc`, as textures by tile
   * key: drawn again only when the float, the document or the shown tiles changed. `source` gives
   * the display tiles as the display shows them now. `doc` must be supported (`supports`).
   */
  tiles(
    doc: CompositeDocument,
    float: FloatLayer,
    level: number,
    visible: readonly TileRef[],
    source: DisplayTileSource,
  ): ReadonlyMap<string, GPUTexture> {
    const region = intersectRects(float.base.region, rect(0, 0, doc.width, doc.height));
    const edge = tileEdge(level);
    const onScreen = visible.filter(
      (tile) =>
        tile.level === level &&
        tile.tx * edge < region.x + region.width &&
        region.x < (tile.tx + 1) * edge &&
        tile.ty * edge < region.y + region.height &&
        region.y < (tile.ty + 1) * edge,
    );
    if (onScreen.length === 0) return new Map();
    const range: TileRange = {
      tx0: Math.min(...onScreen.map((tile) => tile.tx)),
      ty0: Math.min(...onScreen.map((tile) => tile.ty)),
      tx1: Math.max(...onScreen.map((tile) => tile.tx)) + 1,
      ty1: Math.max(...onScreen.map((tile) => tile.ty)) + 1,
    };
    const { copies, levels, shown } = timedStage("float static", () => ({
      copies: this.#copiesFor(doc, float, level),
      levels: this.#levelsFor(doc, level, range),
      shown: this.#shownFor(level, range, source),
    }));
    const key = `${copies.key}|${levels.key}|${shown.key}|${identity(float)}`;
    if (this.#drawn?.key === key) return this.#drawn.tiles;
    const device = this.#device;
    const encoder = device.createCommandEncoder({ label: "float display" });
    timedStage("float draw", () => this.#float.encode(encoder, float, doc, false));
    const buffers: GPUBuffer[] = [];
    // What the shown level may compute in a stale tile: the pixels the copies carry up to it.
    const scale = 2 ** level;
    const reached = grown(region, mipReach(level), doc);
    const valid = rect(
      Math.floor(reached.x / scale),
      Math.floor(reached.y / scale),
      Math.ceil((reached.x + reached.width) / scale) - Math.floor(reached.x / scale),
      Math.ceil((reached.y + reached.height) / scale) - Math.floor(reached.y / scale),
    );
    const tilesAcrossRange = range.tx1 - range.tx0;
    const shownAt = (l: number) =>
      l === level
        ? { fixed: shown.fixed, fresh: shown.fresh, valid, tiles: tilesAcrossRange }
        : undefined;
    const all = levels.levels;
    this.#encodeLevel0(encoder, doc, float, region, copies, all[0] as Level, shownAt(0), buffers);
    for (let index = 1; index < all.length; index++) {
      this.#encodeLevel(
        encoder,
        doc,
        all[index - 1] as Level,
        all[index] as Level,
        shownAt(index),
        buffers,
      );
    }
    const top = all.at(-1) as Level;
    const tiles = new Map<string, GPUTexture>();
    for (const tile of onScreen) {
      const tileKeyText = tileKey(tile.level, tile.tx, tile.ty);
      let texture = this.#textures.get(tileKeyText);
      if (texture === undefined) {
        texture = device.createTexture({
          label: "float display tile",
          size: [DISPLAY_TILE_SIZE, DISPLAY_TILE_SIZE],
          format: "rgba8unorm",
          usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
        });
        this.#textures.set(tileKeyText, texture);
      }
      const x = tile.tx * DISPLAY_TILE_SIZE - top.area.x;
      const y = tile.ty * DISPLAY_TILE_SIZE - top.area.y;
      encoder.copyBufferToTexture(
        { buffer: top.out, offset: (y * top.area.width + x) * 4, bytesPerRow: top.area.width * 4 },
        { texture },
        [DISPLAY_TILE_SIZE, DISPLAY_TILE_SIZE],
      );
      tiles.set(tileKeyText, texture);
    }
    device.queue.submit([encoder.finish()]);
    for (const buffer of buffers) buffer.destroy();
    this.#drawn = { key, tiles };
    return tiles;
  }

  /** Forgets what stays the same, as when no float is shown any more. The float stays cached. */
  release(): void {
    this.#releaseCopies();
    this.#releaseLevels();
    this.#releaseShown();
    for (const texture of this.#textures.values()) texture.destroy();
    this.#textures.clear();
    this.#drawn = undefined;
  }

  destroy(): void {
    this.release();
    this.#float.destroy();
    this.#taps.destroy();
    this.#empty.destroy();
  }

  #releaseCopies(): void {
    const held = this.#copies;
    for (const buffer of [held?.stored, held?.under, held?.over]) buffer?.destroy();
    this.#copies = undefined;
  }

  #releaseLevels(): void {
    for (const level of this.#levels?.levels ?? []) {
      for (const buffer of [level.out, level.changed, level.rows, level.rowsChanged]) {
        buffer?.destroy();
      }
    }
    this.#levels = undefined;
  }

  #releaseShown(): void {
    this.#shownTiles?.fixed.destroy();
    this.#shownTiles?.fresh.destroy();
    this.#shownTiles = undefined;
  }

  #upload(label: string, bytes: Uint8Array | Uint8ClampedArray | Uint32Array): GPUBuffer {
    const buffer = this.#device.createBuffer({
      label,
      size: Math.max(16, bytes.byteLength),
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
    });
    this.#device.queue.writeBuffer(buffer, 0, bytes as Uint8Array<ArrayBuffer>);
    return buffer;
  }

  /**
   * The float's layer as stored and the layers under and above it, over the float's region grown
   * by twice what the mip chain up to `level` reads, so every pixel it carries to the shown level
   * is computed from them.
   */
  #copiesFor(doc: CompositeDocument, float: FloatLayer, level: number): Copies {
    const region = intersectRects(float.base.region, rect(0, 0, doc.width, doc.height));
    const copy = level === 0 ? region : grown(region, 2 * mipReach(level), doc);
    const versions = doc.layers.map((layer) => layer.store.version).join(",");
    const key = [
      identity(doc),
      versions,
      float.index,
      float.baseKey,
      copy.x,
      copy.y,
      copy.width,
      copy.height,
    ].join("/");
    if (this.#copies?.key === key) return this.#copies;
    this.#releaseCopies();
    const copies = timedStage("float layer copies", () => {
      const layer = doc.layers[float.index] as CompositeLayer;
      const stored = layer.store.readRegion(copy);
      const below = doc.layers.slice(0, float.index);
      const above = doc.layers.slice(float.index + 1);
      const over = (layers: readonly CompositeLayer[]) => {
        const sub: CompositeDocument = { width: doc.width, height: doc.height, layers };
        return activeLayers(sub).length > 0 ? compositeCpu(sub, copy).data : undefined;
      };
      const underPixels = over(below);
      const overPixels = over(above);
      return {
        key,
        copy,
        stored: this.#upload("float layer stored", stored.data),
        under: underPixels && this.#upload("float under", underPixels),
        over: overPixels && this.#upload("float over", overPixels),
      };
    });
    this.#copies = copies;
    return copies;
  }

  /** The buffers of levels 0 to `level` over the tiles of `range`. */
  #levelsFor(doc: Size, level: number, range: TileRange): Levels {
    const key = [doc.width, doc.height, level, range.tx0, range.ty0, range.tx1, range.ty1].join(
      "/",
    );
    if (this.#levels?.key === key) return this.#levels;
    this.#releaseLevels();
    const device = this.#device;
    const levels: Level[] = [];
    for (let l = 0; l <= level; l++) {
      const scale = 2 ** (level - l);
      const tx0 = range.tx0 * scale;
      const ty0 = range.ty0 * scale;
      const tx1 = Math.min(range.tx1 * scale, tilesAcross(doc.width, l));
      const ty1 = Math.min(range.ty1 * scale, tilesAcross(doc.height, l));
      const area = rect(
        tx0 * DISPLAY_TILE_SIZE,
        ty0 * DISPLAY_TILE_SIZE,
        (tx1 - tx0) * DISPLAY_TILE_SIZE,
        (ty1 - ty0) * DISPLAY_TILE_SIZE,
      );
      const pixels = area.width * area.height * 4;
      const below = levels.at(-1);
      // The horizontal pass's buffers: this level's columns over the level below's rows.
      const rowsOf = (height: number) => ({
        rows: device.createBuffer({
          label: `float display rows ${l}`,
          size: area.width * height * 16,
          usage: BufferUsage.STORAGE,
        }),
        rowsChanged: device.createBuffer({
          label: `float display row changes ${l}`,
          size: area.width * height * 4,
          usage: BufferUsage.STORAGE,
        }),
      });
      levels.push({
        level: l,
        area,
        out: device.createBuffer({
          label: `float display level ${l}`,
          size: pixels,
          usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC,
        }),
        changed: device.createBuffer({
          label: `float display changes ${l}`,
          size: pixels,
          usage: BufferUsage.STORAGE,
        }),
        ...(below !== undefined && rowsOf(below.area.height)),
      });
    }
    this.#levels = { key, levels };
    return this.#levels;
  }

  /**
   * The bytes of the shown level's tiles over `range` as the display shows them now, and per tile
   * whether it is up to date: copied again only when the display's tiles there changed.
   */
  #shownFor(level: number, range: TileRange, source: DisplayTileSource): ShownTiles {
    const across = range.tx1 - range.tx0;
    const down = range.ty1 - range.ty0;
    const tiles: (ReturnType<DisplayTileSource> | undefined)[] = [];
    const parts: (number | string)[] = [level, range.tx0, range.ty0, across, down];
    for (let ty = range.ty0; ty < range.ty1; ty++) {
      for (let tx = range.tx0; tx < range.tx1; tx++) {
        const shown = source({ level, tx, ty });
        tiles.push(shown);
        parts.push(shown === undefined ? "-" : `${identity(shown.tile)}${shown.fresh ? "" : "s"}`);
      }
    }
    const key = parts.join("/");
    if (this.#shownTiles?.key === key) return this.#shownTiles;
    this.#releaseShown();
    const width = across * DISPLAY_TILE_SIZE;
    const bytes = new Uint8Array(width * down * DISPLAY_TILE_SIZE * 4);
    const fresh = new Uint32Array(across * down);
    timedStage("float shown tiles", () => {
      tiles.forEach((shown, index) => {
        if (shown === undefined) return;
        fresh[index] = shown.fresh ? 1 : 0;
        const ox = (index % across) * DISPLAY_TILE_SIZE;
        const oy = Math.floor(index / across) * DISPLAY_TILE_SIZE;
        for (let row = 0; row < DISPLAY_TILE_SIZE; row++) {
          const from = row * DISPLAY_TILE_SIZE * 4;
          bytes.set(
            shown.tile.pixels.subarray(from, from + DISPLAY_TILE_SIZE * 4),
            ((oy + row) * width + ox) * 4,
          );
        }
      });
    });
    this.#shownTiles = {
      key,
      fixed: this.#upload(`display level ${level}`, bytes),
      fresh: this.#upload("display tiles fresh", fresh),
    };
    return this.#shownTiles;
  }

  #encodeLevel0(
    encoder: GPUCommandEncoder,
    doc: CompositeDocument,
    float: FloatLayer,
    region: Rect,
    copies: Copies,
    target: Level,
    shown: ShownLevel | undefined,
    buffers: GPUBuffer[],
  ): void {
    const device = this.#device;
    const layer = doc.layers[float.index] as CompositeLayer;
    const visible = layer.visible && layer.opacity > 0;
    const { copy } = copies;
    const valid = shown?.valid ?? rect(0, 0, 0, 0);
    const flags =
      (copies.under ? FLAG_UNDER : 0) |
      (copies.over ? FLAG_OVER : 0) |
      (shown === undefined ? FLAG_BELOW : 0);
    const params = new Uint32Array([
      target.area.x,
      target.area.y,
      target.area.width,
      target.area.height,
      region.x,
      region.y,
      region.width,
      region.height,
      copy.x,
      copy.y,
      copy.width,
      copy.height,
      valid.x,
      valid.y,
      valid.width,
      valid.height,
      doc.width,
      doc.height,
      layer.mode,
      visible ? layer.opacity : 0,
      flags,
      shown?.tiles ?? 0,
      0,
      0,
    ]);
    const uniform = this.#uniform(params, buffers);
    const pass = encoder.beginComputePass({ label: "float display level 0" });
    pass.setPipeline(this.#level0);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: this.#level0.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          {
            binding: 1,
            resource: (this.#float.texture as GPUTexture).createView({
              baseMipLevel: 0,
              mipLevelCount: 1,
            }),
          },
          { binding: 2, resource: { buffer: copies.stored } },
          { binding: 3, resource: { buffer: copies.under ?? this.#empty } },
          { binding: 4, resource: { buffer: copies.over ?? this.#empty } },
          { binding: 5, resource: { buffer: shown?.fixed ?? this.#empty } },
          { binding: 6, resource: { buffer: target.out } },
          { binding: 7, resource: { buffer: target.changed } },
          { binding: 8, resource: { buffer: shown?.fresh ?? this.#empty } },
        ],
      }),
    );
    pass.dispatchWorkgroups(
      Math.ceil(target.area.width / WORKGROUP),
      Math.ceil(target.area.height / WORKGROUP),
    );
    pass.end();
  }

  #encodeLevel(
    encoder: GPUCommandEncoder,
    doc: CompositeDocument,
    below: Level,
    target: Level,
    shown: ShownLevel | undefined,
    buffers: GPUBuffer[],
  ): void {
    const device = this.#device;
    const valid = shown?.valid ?? rect(0, 0, 0, 0);
    const params = new Uint32Array([
      target.area.x,
      target.area.y,
      target.area.width,
      target.area.height,
      below.area.x,
      below.area.y,
      below.area.width,
      below.area.height,
      coveredExtent(doc.width, below.level),
      coveredExtent(doc.height, below.level),
      coveredExtent(doc.width, target.level),
      coveredExtent(doc.height, target.level),
      valid.x,
      valid.y,
      valid.width,
      valid.height,
      shown === undefined ? FLAG_BELOW : 0,
      shown?.tiles ?? 0,
      0,
      0,
    ]);
    const uniform = this.#uniform(params, buffers);
    const rows = target.rows as GPUBuffer;
    const rowsChanged = target.rowsChanged as GPUBuffer;
    const pass = encoder.beginComputePass({ label: `float display level ${target.level}` });
    // Across, then down, as the reference resamples: twelve taps each way, not 144.
    pass.setPipeline(this.#levelH);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: this.#levelH.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: this.#taps } },
          { binding: 2, resource: { buffer: below.out } },
          { binding: 3, resource: { buffer: below.changed } },
          { binding: 7, resource: { buffer: rows } },
          { binding: 8, resource: { buffer: rowsChanged } },
        ],
      }),
    );
    pass.dispatchWorkgroups(
      Math.ceil(target.area.width / WORKGROUP),
      Math.ceil(below.area.height / WORKGROUP),
    );
    pass.setPipeline(this.#levelN);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: this.#levelN.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: this.#taps } },
          { binding: 4, resource: { buffer: shown?.fixed ?? this.#empty } },
          { binding: 5, resource: { buffer: target.out } },
          { binding: 6, resource: { buffer: target.changed } },
          { binding: 7, resource: { buffer: rows } },
          { binding: 8, resource: { buffer: rowsChanged } },
          { binding: 9, resource: { buffer: shown?.fresh ?? this.#empty } },
        ],
      }),
    );
    pass.dispatchWorkgroups(
      Math.ceil(target.area.width / WORKGROUP),
      Math.ceil(target.area.height / WORKGROUP),
    );
    pass.end();
  }

  #uniform(words: Uint32Array, buffers: GPUBuffer[]): GPUBuffer {
    const buffer = this.#device.createBuffer({
      label: "float display params",
      size: words.byteLength,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    this.#device.queue.writeBuffer(buffer, 0, words as Uint32Array<ArrayBuffer>);
    buffers.push(buffer);
    return buffer;
  }
}

/** The shown level's inputs to its pass (`FloatDisplay.tiles`). */
interface ShownLevel {
  readonly fixed: GPUBuffer;
  readonly fresh: GPUBuffer;
  /** Where a stale tile's pixels may be computed, in level pixels. */
  readonly valid: Rect;
  /** Tiles across the range. */
  readonly tiles: number;
}
