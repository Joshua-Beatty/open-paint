import { intersectRects, type Rect, rect, type Size, Surface } from "@openpaint/document";
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
 * Level 0 of the display over the affected tiles, as `renderBase` builds it: where the float's
 * layer differs from its stored pixels, the layers under it (one composite), the float with its
 * layer's blend mode and opacity, and the layers above (one composite, Normal) are blended with the
 * WGSL twin of the reference and premultiplied as `premultiply_rgba8` does; everywhere else the
 * display tile's own bytes are kept, and marked unchanged. Pixels past the image repeat its last
 * column and row (`padTile`).
 */
const LEVEL0_WGSL = /* wgsl */ `
struct Params {
  q_x: u32, q_y: u32, q_w: u32, q_h: u32,
  r_x: u32, r_y: u32, r_w: u32, r_h: u32,
  doc_w: u32, doc_h: u32, mode: u32, opacity: u32,
  flags: u32, pad0: u32, pad1: u32, pad2: u32,
}

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var float_tex: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> stored: array<u32>;
@group(0) @binding(3) var<storage, read> under: array<u32>;
@group(0) @binding(4) var<storage, read> over: array<u32>;
@group(0) @binding(5) var<storage, read> fixed_px: array<u32>;
@group(0) @binding(6) var<storage, read_write> out: array<u32>;
@group(0) @binding(7) var<storage, read_write> changed: array<u32>;

${BLEND_WGSL}
${PACKING_WGSL}

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
  var word = fixed_px[i];
  var moved = 0u;
  let q = min(vec2u(p.q_x + id.x, p.q_y + id.y), vec2u(p.doc_w - 1u, p.doc_h - 1u));
  if (q.x >= p.r_x && q.y >= p.r_y && q.x < p.r_x + p.r_w && q.y < p.r_y + p.r_h) {
    let local = q - vec2u(p.r_x, p.r_y);
    let j = local.y * p.r_w + local.x;
    let f = vec4u(round(textureLoad(float_tex, vec2i(local), 0) * 255.0));
    if (any(f != unpack(stored[j]))) {
      var d = vec4u(0u);
      if ((p.flags & 1u) != 0u) {
        d = unpack(under[j]);
      }
      d = composite_pixel(d, f, p.mode, p.opacity);
      if ((p.flags & 2u) != 0u) {
        d = composite_pixel(d, unpack(over[j]), 0u, 255u);
      }
      word = pack(premultiply(d));
      moved = 1u;
    }
  }
  out[i] = word;
  changed[i] = moved;
}
`;

/**
 * One display mip level over the affected tiles from the level below, as the final display tiles
 * are built (`downsample` with Lanczos-3): each tile from its 2x2 children only, the block padded
 * past the image's covered pixels, the taps of `resample_lanczos3_rgba8` applied in its order,
 * horizontal then vertical, with color clamped to alpha. A pixel none of whose taps changed keeps
 * the display tile's own bytes, so it is exactly what the display shows.
 */
const LANCZOS_WGSL = /* wgsl */ `
struct Params {
  q_x: u32, q_y: u32, q_w: u32, q_h: u32,
  p_x: u32, p_y: u32, p_w: u32, p_h: u32,
  cover_pw: u32, cover_ph: u32, cover_w: u32, cover_h: u32,
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

${PACKING_WGSL}

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
  if (moved == 0u) {
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
  /** The display tiles' own bytes. */
  readonly fixed: GPUBuffer;
  readonly out: GPUBuffer;
  readonly changed: GPUBuffer;
  /** The horizontal pass over the level below (levels above 0). */
  readonly rows?: GPUBuffer;
  readonly rowsChanged?: GPUBuffer;
}

/** What stays the same while the float moves: the layers' pixels around it, and the display's. */
interface Static {
  readonly key: string;
  readonly region: Rect;
  readonly stored: GPUBuffer;
  readonly under: GPUBuffer | undefined;
  readonly over: GPUBuffer | undefined;
  readonly levels: readonly Level[];
}

/** The display tiles the float shows in, at one level: a range of tiles `tx0..tx1`, `ty0..ty1`. */
interface TileRange {
  readonly tx0: number;
  readonly ty0: number;
  readonly tx1: number;
  readonly ty1: number;
}

/** Gives the final display tile at `ref` (built now when needed), as the display shows it. */
export type DisplayTileSource = (ref: TileRef) => DisplayTile;

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
 * tiles with the same quads and sampling. Pixels the float does not change, and every mip pixel
 * none of whose sources changed, keep the cached tile's bytes, so the image around the moved
 * content is exactly what the display showed before; the moved content is what the tiles will
 * show once the step is recorded, within ±1. Nothing is read back.
 */
export class FloatDisplay {
  readonly #device: GPUDevice;
  readonly #float: FloatGpu;
  readonly #taps: GPUBuffer;
  readonly #empty: GPUBuffer;
  #static: Static | undefined;
  /** Tile textures by tile key, reused from frame to frame. */
  readonly #textures = new Map<string, GPUTexture>();
  /** The tiles the last call drew, and what they show. */
  #shown: { readonly key: string; readonly tiles: ReadonlyMap<string, GPUTexture> } | undefined;

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
   * key: drawn again only when the float, the document or the tiles changed. `source` gives the
   * cached final tiles the unchanged pixels come from. `doc` must be supported (`supports`).
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
    const shown = visible.filter(
      (tile) =>
        tile.level === level &&
        tile.tx * edge < region.x + region.width &&
        region.x < (tile.tx + 1) * edge &&
        tile.ty * edge < region.y + region.height &&
        region.y < (tile.ty + 1) * edge,
    );
    if (shown.length === 0) return new Map();
    const range: TileRange = {
      tx0: Math.min(...shown.map((tile) => tile.tx)),
      ty0: Math.min(...shown.map((tile) => tile.ty)),
      tx1: Math.max(...shown.map((tile) => tile.tx)) + 1,
      ty1: Math.max(...shown.map((tile) => tile.ty)) + 1,
    };
    const versions = doc.layers.map((layer) => layer.store.version).join(",");
    const staticKey = [
      identity(doc),
      versions,
      float.index,
      float.baseKey,
      level,
      range.tx0,
      range.ty0,
      range.tx1,
      range.ty1,
    ].join("/");
    const key = `${staticKey}/${identity(float)}`;
    if (this.#shown?.key === key) return this.#shown.tiles;
    const fixed = this.#staticFor(staticKey, doc, float, level, range, source);
    const device = this.#device;
    const encoder = device.createCommandEncoder({ label: "float display" });
    this.#float.encode(encoder, float, doc, false);
    const buffers: GPUBuffer[] = [];
    this.#encodeLevel0(encoder, doc, float, fixed, buffers);
    for (let index = 1; index < fixed.levels.length; index++) {
      this.#encodeLevel(
        encoder,
        doc,
        fixed.levels[index - 1] as Level,
        fixed.levels[index] as Level,
        buffers,
      );
    }
    const top = fixed.levels.at(-1) as Level;
    const tiles = new Map<string, GPUTexture>();
    for (const tile of shown) {
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
    this.#shown = { key, tiles };
    return tiles;
  }

  /** Forgets what stays the same, as when no float is shown any more. The float stays cached. */
  release(): void {
    this.#releaseStatic();
    for (const texture of this.#textures.values()) texture.destroy();
    this.#textures.clear();
    this.#shown = undefined;
  }

  destroy(): void {
    this.release();
    this.#float.destroy();
    this.#taps.destroy();
    this.#empty.destroy();
  }

  #releaseStatic(): void {
    const held = this.#static;
    if (held === undefined) return;
    for (const buffer of [held.stored, held.under, held.over]) buffer?.destroy();
    for (const level of held.levels) {
      for (const buffer of [level.fixed, level.out, level.changed, level.rows, level.rowsChanged]) {
        buffer?.destroy();
      }
    }
    this.#static = undefined;
  }

  /**
   * The parts that do not change while the float moves: the float's layer as stored and the layers
   * under and above it over the float's region, and per level the cached display tiles' bytes.
   */
  #staticFor(
    key: string,
    doc: CompositeDocument,
    float: FloatLayer,
    level: number,
    range: TileRange,
    source: DisplayTileSource,
  ): Static {
    if (this.#static?.key === key) return this.#static;
    this.#releaseStatic();
    const device = this.#device;
    const region = float.base.region;
    const upload = (label: string, bytes: Uint8Array | Uint8ClampedArray) => {
      const buffer = device.createBuffer({
        label,
        size: Math.max(16, bytes.byteLength),
        usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(buffer, 0, bytes as Uint8Array<ArrayBuffer>);
      return buffer;
    };
    const overRegion = (layers: readonly CompositeLayer[]): Surface => {
      const sub: CompositeDocument = { width: doc.width, height: doc.height, layers };
      const out = new Surface(region.width, region.height);
      const composite = compositeCpu(sub, inside);
      out.copyFrom(composite, composite.bounds, inside.x - region.x, inside.y - region.y);
      return out;
    };
    const layer = doc.layers[float.index] as CompositeLayer;
    const inside = intersectRects(region, rect(0, 0, doc.width, doc.height));
    const storedPixels = new Surface(region.width, region.height);
    const read = layer.store.readRegion(inside);
    storedPixels.copyFrom(read, read.bounds, inside.x - region.x, inside.y - region.y);
    const stored = upload("float layer stored", storedPixels.data);
    const below = doc.layers.slice(0, float.index);
    const above = doc.layers.slice(float.index + 1);
    const sub = (layers: readonly CompositeLayer[]) =>
      activeLayers({ width: doc.width, height: doc.height, layers }).length > 0;
    const under = sub(below) ? upload("float under", overRegion(below).data) : undefined;
    const over = sub(above) ? upload("float over", overRegion(above).data) : undefined;
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
      const bytes = new Uint8Array(area.width * area.height * 4);
      for (let ty = ty0; ty < ty1; ty++) {
        for (let tx = tx0; tx < tx1; tx++) {
          const tile = source({ level: l, tx, ty });
          const ox = (tx - tx0) * DISPLAY_TILE_SIZE;
          const oy = (ty - ty0) * DISPLAY_TILE_SIZE;
          for (let row = 0; row < DISPLAY_TILE_SIZE; row++) {
            const from = row * DISPLAY_TILE_SIZE * 4;
            bytes.set(
              tile.pixels.subarray(from, from + DISPLAY_TILE_SIZE * 4),
              ((oy + row) * area.width + ox) * 4,
            );
          }
        }
      }
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
        fixed: upload(`display level ${l}`, bytes),
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
    this.#static = { key, region, stored, under, over, levels };
    return this.#static;
  }

  #encodeLevel0(
    encoder: GPUCommandEncoder,
    doc: CompositeDocument,
    float: FloatLayer,
    fixed: Static,
    buffers: GPUBuffer[],
  ): void {
    const device = this.#device;
    const target = fixed.levels[0] as Level;
    const layer = doc.layers[float.index] as CompositeLayer;
    const visible = layer.visible && layer.opacity > 0;
    const region = fixed.region;
    const params = new Uint32Array([
      target.area.x,
      target.area.y,
      target.area.width,
      target.area.height,
      region.x,
      region.y,
      region.width,
      region.height,
      doc.width,
      doc.height,
      layer.mode,
      visible ? layer.opacity : 0,
      (fixed.under ? 1 : 0) | (fixed.over ? 2 : 0),
      0,
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
          { binding: 2, resource: { buffer: fixed.stored } },
          { binding: 3, resource: { buffer: fixed.under ?? this.#empty } },
          { binding: 4, resource: { buffer: fixed.over ?? this.#empty } },
          { binding: 5, resource: { buffer: target.fixed } },
          { binding: 6, resource: { buffer: target.out } },
          { binding: 7, resource: { buffer: target.changed } },
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
    buffers: GPUBuffer[],
  ): void {
    const device = this.#device;
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
          { binding: 4, resource: { buffer: target.fixed } },
          { binding: 5, resource: { buffer: target.out } },
          { binding: 6, resource: { buffer: target.changed } },
          { binding: 7, resource: { buffer: rows } },
          { binding: 8, resource: { buffer: rowsChanged } },
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
