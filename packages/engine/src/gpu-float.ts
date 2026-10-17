import {
  affineBounds,
  composeAffine,
  intersectRects,
  invertAffine,
  isIntegerTranslation,
  type Rect,
  rect,
  type Size,
  translationAffine,
} from "@openpaint/document";
import type { FloatLayer, SyncPlacement } from "./document-sync";
import { BufferUsage, TextureUsage } from "./gpu-device";
import { footprintGrid, TRANSFORM_SAMPLING_WGSL } from "./gpu-transform";
import { timedStage } from "./perf";
import { type ShapeRuns, shapeRuns } from "./shape-runs";

/** Most mip levels the float's texture has: 256 px regions halve exactly down to 1 px. */
const MAX_LEVELS = 9;
const PARAMS_BYTES = 96;

/** A whole-pixel move places the content by its own coverage; any other transform resamples it. */
const MODE_RESAMPLE = 0;
const MODE_INTEGER = 1;

/**
 * Draws the floating content onto the base over the region, as `FloatingSource.compose` does: a
 * whole-pixel move places the content's own pixels by its coverage; any other transform resamples
 * it (`TRANSFORM_SAMPLING_WGSL`) and covers it with the moved shape, whose mask comes as runs over
 * the covered rectangle (`shapeRuns`, exactly the reference's bytes). Partial coverage blends as
 * `placeByCoverage`. Pixels past the image are transparent.
 */
export const FLOAT_COMPOSE_WGSL = /* wgsl */ `
struct Params {
  src_w: u32,
  src_h: u32,
  region_w: u32,
  region_h: u32,
  sampling: u32,
  linear_light: u32,
  grid_x: u32,
  grid_y: u32,
  a: f32,
  b: f32,
  c: f32,
  d: f32,
  e: f32,
  f: f32,
  mode: u32,
  has_coverage: u32,
  dx: i32,
  dy: i32,
  doc_w: u32,
  doc_h: u32,
  covered: vec4<u32>,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read> coverage: array<u32>;
@group(0) @binding(3) var base: texture_2d<f32>;
@group(0) @binding(4) var out_tex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(5) var<storage, read> row_offsets: array<u32>;
@group(0) @binding(6) var<storage, read> breaks: array<u32>;

${TRANSFORM_SAMPLING_WGSL}

fn unpack(word: u32) -> vec4<u32> {
  return vec4<u32>(word & 255u, (word >> 8u) & 255u, (word >> 16u) & 255u, word >> 24u);
}

fn coverage_byte(i: u32) -> u32 {
  return (coverage[i >> 2u] >> ((i & 3u) * 8u)) & 255u;
}

// The moved shape's coverage of a region pixel: the value of the last break at or before it in
// its row of the covered rectangle, 0 outside it.
fn shape_coverage(x: u32, y: u32) -> u32 {
  let r = p.covered;
  if (x < r.x || y < r.y || x >= r.x + r.z || y >= r.y + r.w) {
    return 0u;
  }
  let lx = x - r.x;
  let row = y - r.y;
  var lo = row_offsets[row];
  var hi = row_offsets[row + 1u];
  var value = 0u;
  while (lo < hi) {
    let mid = (lo + hi) / 2u;
    let word = breaks[mid];
    if ((word >> 8u) <= lx) {
      value = word & 255u;
      lo = mid + 1u;
    } else {
      hi = mid;
    }
  }
  return value;
}

@compute @workgroup_size(8, 8)
fn compose_main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.region_w || id.y >= p.region_h) {
    return;
  }
  let b = vec4<u32>(round(textureLoad(base, vec2<i32>(id.xy), 0) * 255.0));
  var out = vec4<u32>(0u);
  if (id.x < p.doc_w && id.y < p.doc_h) {
    var s = vec4<u32>(0u);
    var c = 0u;
    if (p.mode == ${MODE_INTEGER}u) {
      let sx = i32(id.x) - p.dx;
      let sy = i32(id.y) - p.dy;
      if (sx >= 0 && sy >= 0 && sx < i32(p.src_w) && sy < i32(p.src_h)) {
        let i = u32(sy) * p.src_w + u32(sx);
        s = unpack(src[i]);
        c = 255u;
        if (p.has_coverage == 1u) {
          c = coverage_byte(i);
        }
      }
    } else {
      c = shape_coverage(id.x, id.y);
      if (c > 0u) {
        let cx = f32(id.x) + 0.5;
        let cy = f32(id.y) + 0.5;
        let center = vec2<f32>(p.a * cx + p.c * cy + p.e, p.b * cx + p.d * cy + p.f);
        var color: vec4<f32>;
        switch (p.sampling) {
          case 0u: {
            color = nearest(center);
          }
          case 4u: {
            color = cubic(center);
          }
          case 1u: {
            color = bilinear(center);
          }
          default: {
            color = footprint(center, vec2<f32>(p.a, p.b), vec2<f32>(p.c, p.d));
          }
        }
        s = unpack(encode(color));
      }
    }
    out = b;
    if (c == 255u) {
      out = s;
    } else if (c > 0u) {
      out = (b * (255u - c) + s * c + vec4<u32>(127u)) / 255u;
    }
  }
  textureStore(out_tex, vec2<i32>(id.xy), vec4<f32>(out) / 255.0);
}
`;

/**
 * One mip level of the float from the level above: a 2×2 box weighted by alpha, as the v2 tile
 * mips (`MIP_WGSL`), so transparent pixels do not darken straight-alpha colors.
 */
export const FLOAT_MIP_WGSL = /* wgsl */ `
@group(0) @binding(0) var src_level: texture_2d<f32>;
@group(0) @binding(1) var dst_level: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn mip_main(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(dst_level);
  if (id.x >= size.x || id.y >= size.y) {
    return;
  }
  let last = vec2<i32>(textureDimensions(src_level)) - vec2<i32>(1);
  let q = vec2<i32>(id.xy) * 2;
  let a = textureLoad(src_level, min(q, last), 0);
  let b = textureLoad(src_level, min(q + vec2<i32>(1, 0), last), 0);
  let c = textureLoad(src_level, min(q + vec2<i32>(0, 1), last), 0);
  let d = textureLoad(src_level, min(q + vec2<i32>(1, 1), last), 0);
  let alpha = a.a + b.a + c.a + d.a;
  var rgb = vec3<f32>(0.0);
  if (alpha > 0.0) {
    rgb = (a.rgb * a.a + b.rgb * b.a + c.rgb * c.a + d.rgb * d.a) / alpha;
  }
  textureStore(dst_level, vec2<i32>(id.xy), vec4<f32>(rgb, alpha * 0.25));
}
`;

/** The matrix of a placement. */
function matrixOf(placement: SyncPlacement) {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = placement.transform;
  return { a, b, c, d, e, f };
}

/**
 * The canvas rectangle the content covers at a placement, within the image: where the reference
 * resamples it and rasterizes the moved shape (`FloatingSource.compose`).
 */
export function coveredRect(placement: SyncPlacement, content: Size, doc: Size): Rect {
  return intersectRects(
    affineBounds(rect(0, 0, content.width, content.height), matrixOf(placement)),
    rect(0, 0, doc.width, doc.height),
  );
}

/** The `Params` uniform of one placement over the float's region. */
export function placementParams(
  placement: SyncPlacement,
  float: Pick<FloatLayer, "content" | "base">,
  doc: Size,
  covered: Rect,
): ArrayBuffer {
  const m = matrixOf(placement);
  const { region } = float.base;
  const { width, height, coverage } = float.content;
  const integer = isIntegerTranslation(m);
  const inverse = integer
    ? m
    : composeAffine(invertAffine(m), translationAffine(region.x, region.y));
  const coefficients = [inverse.a, inverse.b, inverse.c, inverse.d, inverse.e, inverse.f];
  const [gridX, gridY] = footprintGrid({ inverse: coefficients, sampling: placement.sampling });
  const view = new DataView(new ArrayBuffer(PARAMS_BYTES));
  const words = [width, height, region.width, region.height, placement.sampling];
  words.push(placement.linearLight ? 1 : 0, gridX, gridY);
  words.forEach((value, i) => {
    view.setUint32(i * 4, value, true);
  });
  coefficients.forEach((value, i) => {
    view.setFloat32(32 + i * 4, value, true);
  });
  view.setUint32(56, integer ? MODE_INTEGER : MODE_RESAMPLE, true);
  view.setUint32(60, coverage === undefined ? 0 : 1, true);
  view.setInt32(64, integer ? m.e - region.x : 0, true);
  view.setInt32(68, integer ? m.f - region.y : 0, true);
  view.setUint32(72, Math.max(0, doc.width - region.x), true);
  view.setUint32(76, Math.max(0, doc.height - region.y), true);
  const local = [covered.x - region.x, covered.y - region.y, covered.width, covered.height];
  local.forEach((value, i) => {
    view.setUint32(80 + i * 4, Math.max(0, value), true);
  });
  return view.buffer;
}

function samePlacement(a: SyncPlacement, b: SyncPlacement): boolean {
  return (
    a.sampling === b.sampling &&
    a.linearLight === b.linearLight &&
    a.antialiased === b.antialiased &&
    a.transform.every((value, i) => value === b.transform[i]) &&
    a.coords.length === b.coords.length &&
    a.coords.every((value, i) => value === b.coords[i])
  );
}

/** Whether a device can hold a float: its region as a texture, its content in one buffer. */
export function floatFits(
  limits: Pick<GPUSupportedLimits, "maxTextureDimension2D" | "maxStorageBufferBindingSize">,
  content: Size,
  region: Size,
): boolean {
  return (
    region.width <= limits.maxTextureDimension2D &&
    region.height <= limits.maxTextureDimension2D &&
    content.width * content.height * 4 <= limits.maxStorageBufferBindingSize
  );
}

interface Uniforms {
  readonly params: GPUBuffer;
  readonly offsets: GPUBuffer;
  readonly breaks: GPUBuffer;
}

/**
 * Floating content on the GPU (TL-MOVE-PIX-01): the content and the base are uploaded once per key,
 * and each frame draws the placement into a texture over the region, with a mip chain, which the
 * compositor reads instead of the layer there. Nothing is read back. Stamps are drawn into the base
 * on the GPU as they arrive.
 */
export class FloatGpu {
  readonly #device: GPUDevice;
  readonly #composePipeline: GPUComputePipeline;
  readonly #mipPipeline: GPUComputePipeline;
  /** The frame's uniforms, grown as needed. */
  #frame: Uniforms | undefined;
  #contentKey: number | undefined;
  #src: GPUBuffer | undefined;
  #coverage: GPUBuffer | undefined;
  #baseKey: number | undefined;
  #region: Rect | undefined;
  #base: GPUTexture | undefined;
  #out: GPUTexture | undefined;
  /** The stamps drawn into the base since it was uploaded. */
  #stamped: readonly SyncPlacement[] = [];

  constructor(device: GPUDevice) {
    this.#device = device;
    const pipeline = (label: string, code: string, entryPoint: string) =>
      device.createComputePipeline({
        label,
        layout: "auto",
        compute: { module: device.createShaderModule({ label, code }), entryPoint },
      });
    this.#composePipeline = pipeline("float compose", FLOAT_COMPOSE_WGSL, "compose_main");
    this.#mipPipeline = pipeline("float mip", FLOAT_MIP_WGSL, "mip_main");
  }

  /** The region the texture covers, in image pixels. */
  get region(): Rect | undefined {
    return this.#region;
  }

  /** The layer's pixels over the region (straight RGBA8), with a mip chain. */
  get texture(): GPUTexture | undefined {
    return this.#out;
  }

  /**
   * Records the commands that show `float` in a `doc`-sized image: uploads of a new content or
   * base, new stamps, then the placement and, unless `mips` is false, its mip chain.
   */
  encode(encoder: GPUCommandEncoder, float: FloatLayer, doc: Size, mips = true): void {
    timedStage("float upload", () => this.#upload(float));
    const stamps = float.stamps;
    for (let i = this.#stamped.length; i < stamps.length; i++) {
      // Each stamp has its own uniforms, so it goes in its own submission before the frame's.
      const own = this.#device.createCommandEncoder({ label: "float stamp" });
      const uniforms = this.#draw(own, stamps[i] as SyncPlacement, float, doc, undefined);
      const { width, height } = float.base.region;
      own.copyTextureToTexture(
        { texture: this.#out as GPUTexture },
        { texture: this.#base as GPUTexture },
        [width, height],
      );
      this.#device.queue.submit([own.finish()]);
      for (const buffer of Object.values(uniforms)) buffer.destroy();
    }
    this.#stamped = stamps;
    this.#frame = this.#draw(encoder, float.placement, float, doc, this.#frame);
    if (mips) this.#mips(encoder);
  }

  destroy(): void {
    for (const buffer of Object.values(this.#frame ?? {})) buffer.destroy();
    for (const resource of [this.#src, this.#coverage, this.#base, this.#out]) resource?.destroy();
    this.#frame = this.#src = this.#coverage = undefined;
    this.#base = this.#out = undefined;
    this.#contentKey = this.#baseKey = this.#region = undefined;
  }

  #upload(float: FloatLayer): void {
    const device = this.#device;
    if (this.#contentKey !== float.contentKey) {
      const { pixels, coverage } = float.content;
      this.#src?.destroy();
      this.#coverage?.destroy();
      this.#src = device.createBuffer({
        label: "float content",
        size: Math.max(4, pixels.byteLength),
        usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
      });
      if (pixels.byteLength > 0) {
        device.queue.writeBuffer(this.#src, 0, pixels as Uint8Array<ArrayBuffer>);
      }
      const words = new Uint8Array(Math.max(4, Math.ceil((coverage?.length ?? 0) / 4) * 4));
      if (coverage !== undefined) words.set(coverage);
      this.#coverage = device.createBuffer({
        label: "float coverage",
        size: words.byteLength,
        usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(this.#coverage, 0, words);
      this.#contentKey = float.contentKey;
    }
    const restamp =
      float.stamps.length < this.#stamped.length ||
      this.#stamped.some((stamp, i) => !samePlacement(stamp, float.stamps[i] as SyncPlacement));
    if (this.#baseKey === float.baseKey && !restamp) return;
    const { region, pixels } = float.base;
    const sized =
      this.#region !== undefined &&
      this.#region.width === region.width &&
      this.#region.height === region.height;
    if (!sized) {
      this.#base?.destroy();
      this.#out?.destroy();
      const levels = Math.min(
        MAX_LEVELS,
        Math.floor(Math.log2(Math.max(1, Math.min(region.width, region.height)))) + 1,
      );
      this.#base = device.createTexture({
        label: "float base",
        size: [region.width, region.height],
        format: "rgba8unorm",
        usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
      });
      this.#out = device.createTexture({
        label: "float layer",
        size: [region.width, region.height],
        format: "rgba8unorm",
        mipLevelCount: levels,
        usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_SRC,
      });
    }
    device.queue.writeTexture(
      { texture: this.#base as GPUTexture },
      pixels as Uint8Array<ArrayBuffer>,
      { bytesPerRow: region.width * 4 },
      [region.width, region.height],
    );
    this.#region = region;
    this.#baseKey = float.baseKey;
    this.#stamped = [];
  }

  /**
   * Draws one placement onto the base into level 0 of the texture, with `reuse`'s buffers when they
   * are large enough (a frame's), or new ones (a stamp's, in its own submission). Returns the
   * buffers it used.
   */
  #draw(
    encoder: GPUCommandEncoder,
    placement: SyncPlacement,
    float: FloatLayer,
    doc: Size,
    reuse: Uniforms | undefined,
  ): Uniforms {
    const device = this.#device;
    const region = float.base.region;
    const covered = coveredRect(placement, float.content, doc);
    const runs: ShapeRuns = isIntegerTranslation(matrixOf(placement))
      ? { offsets: new Uint32Array(1), breaks: new Uint32Array(0) }
      : shapeRuns(placement.coords, placement.counts, covered, placement.antialiased);
    const sized = (buffer: GPUBuffer | undefined, bytes: number, label: string) => {
      const size = 2 ** Math.ceil(Math.log2(Math.max(16, bytes)));
      if (buffer !== undefined && buffer.size >= bytes) return buffer;
      buffer?.destroy();
      return device.createBuffer({
        label,
        size,
        usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
      });
    };
    const uniforms: Uniforms = {
      params:
        reuse?.params ??
        device.createBuffer({
          label: "float params",
          size: PARAMS_BYTES,
          usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
        }),
      offsets: sized(reuse?.offsets, runs.offsets.byteLength, "float shape rows"),
      breaks: sized(reuse?.breaks, runs.breaks.byteLength, "float shape runs"),
    };
    device.queue.writeBuffer(uniforms.params, 0, placementParams(placement, float, doc, covered));
    device.queue.writeBuffer(uniforms.offsets, 0, runs.offsets as Uint32Array<ArrayBuffer>);
    if (runs.breaks.byteLength > 0) {
      device.queue.writeBuffer(uniforms.breaks, 0, runs.breaks as Uint32Array<ArrayBuffer>);
    }
    const pass = encoder.beginComputePass({ label: "float" });
    pass.setPipeline(this.#composePipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: this.#composePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniforms.params } },
          { binding: 1, resource: { buffer: this.#src as GPUBuffer } },
          { binding: 2, resource: { buffer: this.#coverage as GPUBuffer } },
          { binding: 3, resource: (this.#base as GPUTexture).createView() },
          {
            binding: 4,
            resource: (this.#out as GPUTexture).createView({ baseMipLevel: 0, mipLevelCount: 1 }),
          },
          { binding: 5, resource: { buffer: uniforms.offsets } },
          { binding: 6, resource: { buffer: uniforms.breaks } },
        ],
      }),
    );
    pass.dispatchWorkgroups(Math.ceil(region.width / 8), Math.ceil(region.height / 8));
    pass.end();
    return uniforms;
  }

  #mips(encoder: GPUCommandEncoder): void {
    const out = this.#out;
    if (out === undefined) return;
    const pass = encoder.beginComputePass({ label: "float mips" });
    pass.setPipeline(this.#mipPipeline);
    for (let level = 1; level < out.mipLevelCount; level++) {
      const width = Math.max(1, out.width >> level);
      const height = Math.max(1, out.height >> level);
      pass.setBindGroup(
        0,
        this.#device.createBindGroup({
          layout: this.#mipPipeline.getBindGroupLayout(0),
          entries: [
            {
              binding: 0,
              resource: out.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }),
            },
            { binding: 1, resource: out.createView({ baseMipLevel: level, mipLevelCount: 1 }) },
          ],
        }),
      );
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    }
    pass.end();
  }
}
