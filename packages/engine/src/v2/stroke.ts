import { TILE_SIZE } from "@openpaint/document";
import { type BrushOptions, brushSettingsOf } from "../brush";
import { clampHardness, nominalReach } from "../brush-segments";
import { brushJoinsDabs, DabPlanner } from "../cpu";
import { BufferUsage } from "../gpu-device";
import type { GpuDocument } from "./gpu-document";
import { SLOT_BYTES, type SlotBuffer } from "./slot-buffer";
import { planStamps, type TileStamp } from "./stroke-plan";
import { RESOLVE_WGSL, STAMP_WGSL } from "./wgsl";

/** The blend value that replaces the destination (TL-OPT-BLEND "Overwrite"). */
const OVERWRITE_BLEND = 14;
/** `paint_mode` of the stamp shader. */
const PAINT = { blend: 0, erase: 1, overwrite: 2 } as const;
const STROKE_BYTES = 80;
const TILE_PARAMS_BYTES = 80;
const RESOLVE_BYTES = 16;
const STRIDE = 256;
/** `GPUMapMode.READ`. */
const MAP_READ_MODE = 1;
/** `GPUShaderStage.COMPUTE`. */
const COMPUTE_STAGE = 0x4;

/** The selection coverage over a rectangle of the image, one byte per pixel (TL-FRAME-04). */
export interface StrokeMask {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** What a Paintbrush or Eraser stroke paints with: the same inputs as the CPU stroke. */
export interface StrokeBegin {
  readonly layerId: number;
  readonly options: BrushOptions;
  /** The selection's coverage, or undefined when nothing is selected. */
  readonly mask?: StrokeMask;
}

/** One tile of a committed stroke as the main thread records it: the whole tile, RGBA8. */
export interface StrokeTile {
  readonly tx: number;
  readonly ty: number;
  readonly pixels: Uint8Array;
}

/** The compiled stamp and resolve shaders, shared by every stroke on a device. */
export class StrokePipelines {
  readonly stamp: GPUComputePipeline;
  readonly stampLayout: GPUBindGroupLayout;
  readonly resolve: GPUComputePipeline;
  readonly resolveLayout: GPUBindGroupLayout;
  /** Copies one slot to another (same layout as `resolve`). */
  readonly copy: GPUComputePipeline;

  constructor(device: GPUDevice) {
    const uniform = (binding: number, dynamic: boolean): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: COMPUTE_STAGE,
      buffer: { type: "uniform", hasDynamicOffset: dynamic },
    });
    const storage = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: COMPUTE_STAGE,
      buffer: { type },
    });
    this.stampLayout = device.createBindGroupLayout({
      label: "v2 stamp",
      entries: [
        uniform(0, false),
        uniform(1, true),
        storage(3, "read-only-storage"),
        storage(4, "read-only-storage"),
        storage(5, "storage"),
        storage(6, "read-only-storage"),
      ],
    });
    this.resolveLayout = device.createBindGroupLayout({
      label: "v2 resolve",
      entries: [uniform(0, true), storage(1, "storage")],
    });
    this.stamp = device.createComputePipeline({
      label: "v2 stamp",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.stampLayout] }),
      compute: {
        module: device.createShaderModule({ label: "v2 stamp", code: STAMP_WGSL }),
        entryPoint: "stamp",
      },
    });
    const resolve = device.createShaderModule({ label: "v2 resolve", code: RESOLVE_WGSL });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.resolveLayout] });
    this.resolve = device.createComputePipeline({
      label: "v2 resolve",
      layout,
      compute: { module: resolve, entryPoint: "resolve" },
    });
    this.copy = device.createComputePipeline({
      label: "v2 slot copy",
      layout,
      compute: { module: resolve, entryPoint: "copy" },
    });
  }
}

interface Tile {
  readonly tx: number;
  readonly ty: number;
  /** The stroke so far over the original pixels (stroke slots). */
  readonly final: number;
  /** The pool slot shown in place of the layer's tile while the stroke runs. */
  readonly preview: number;
  /** The layer's pixels before the stroke, which every dab paints from. */
  readonly original: number;
  /**
   * The stroke's values so far from its final parts, four words per pixel in four slots: a round
   * tip's field integrals and the stretch of path seen, or a square tip's largest coverage in
   * `cover`.
   */
  readonly cover: number;
  readonly cover2: number;
  readonly cover3: number;
  readonly cover4: number;
  /** With a selection: the selection coverage and the clipped result. */
  readonly mask: number | undefined;
  readonly out: number | undefined;
  /** Holds `final` plus the provisional dabs while some touch this tile. */
  scratch: number | undefined;
  /** Shows provisional dabs since the last frame. */
  tailed: boolean;
  /** Its slots still need their first contents. */
  fresh: boolean;
}

/**
 * One Paintbrush or Eraser stroke painted in the engine worker. Each
 * batch of samples is planned by the Rust dab planner, so only the new dabs are stamped. The
 * stroke's tiles are painted in stroke slots and shown through preview slots that override the
 * layer's tiles, which stay untouched until `commit`, so cancelling is free.
 */
export class GpuStroke {
  readonly layerId: number;
  readonly #device: GPUDevice;
  readonly #doc: GpuDocument;
  readonly #pipelines: StrokePipelines;
  readonly #slots: SlotBuffer;
  readonly #mask: StrokeMask | undefined;
  readonly #planner: DabPlanner;
  /** Whether consecutive dabs are joined into a path (spacing below 100 %). */
  readonly #joined: boolean;
  readonly #square: boolean;
  readonly #antialias: boolean;
  readonly #strokeUniform: GPUBuffer;
  readonly #tiles = new Map<number, Tile>();
  readonly #buffers = new Map<string, GPUBuffer>();
  /**
   * Final dabs not stamped yet, as `x, y, diameter` triples. When joined, they start with the last
   * dab already stamped, so their segments continue the stroke.
   */
  #pendingDabs: number[] = [];
  /** The arc length along the stroke of each pending dab. */
  #pendingArcs: number[] = [];
  /** Whether the pending dabs begin at the stroke's first dab, and whether they end the stroke. */
  #pendingStarts = false;
  #pendingEnds = false;
  /** Whether the provisional dabs begin at the stroke's first dab, and the first one's arc length. */
  #tailStarts = false;
  #tailArc = 0;
  /** The provisional dabs to preview, replaced by every batch. */
  #tail: Float32Array = new Float32Array();
  #finished = false;

  constructor(
    device: GPUDevice,
    doc: GpuDocument,
    pipelines: StrokePipelines,
    slots: SlotBuffer,
    begin: StrokeBegin,
  ) {
    if (!doc.table.has(begin.layerId)) {
      throw new Error(`Layer ${begin.layerId} is not part of the engine's document.`);
    }
    this.layerId = begin.layerId;
    this.#device = device;
    this.#doc = doc;
    this.#pipelines = pipelines;
    this.#slots = slots;
    this.#mask = begin.mask;
    const { options } = begin;
    if (options.blend > OVERWRITE_BLEND)
      throw new RangeError(`unknown blend mode ${options.blend}`);
    const settings = brushSettingsOf(options);
    try {
      this.#planner = new DabPlanner(settings);
      this.#joined = brushJoinsDabs(settings);
    } finally {
      settings.free();
    }
    this.#square = options.square;
    this.#antialias = options.antialias;
    this.#strokeUniform = device.createBuffer({
      label: "v2 stroke",
      size: STROKE_BYTES,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    const paint = options.erase
      ? PAINT.erase
      : options.blend === OVERWRITE_BLEND
        ? PAINT.overwrite
        : PAINT.blend;
    const { color, background } = options;
    const bits = (value: number) => new Uint32Array(new Float32Array([value]).buffer)[0] ?? 0;
    device.queue.writeBuffer(
      this.#strokeUniform,
      0,
      new Uint32Array([
        bits(clampHardness(options.hardness)),
        paint,
        options.blend,
        options.antialias ? 1 : 0,
        color.r,
        color.g,
        color.b,
        color.a,
        background.r,
        background.g,
        background.b,
        background.a,
        options.erase ? 0 : options.hatch,
        doc.width,
        doc.height,
        options.square ? 1 : 0,
        bits(nominalReach(options.size, options.antialias)),
        0,
        0,
        0,
      ]),
    );
  }

  /** Whether stamping work is waiting for the next frame. */
  get pending(): boolean {
    return this.#pendingDabs.length > 0 || this.#tail.length > 0 || this.#hasTailed();
  }

  /** Adds pointer samples (flat `x, y, pressure` triples in image pixels). */
  push(samples: Float32Array): void {
    if (this.#finished) return;
    const batch = this.#planner.push(samples);
    this.#queue(batch, this.#planner.starts(), false, this.#planner.arc());
    this.#tail = this.#planner.tail();
    this.#tailStarts = this.#planner.tail_starts();
    this.#tailArc = this.#planner.tail_arc();
  }

  /** Places the stroke's last dabs. The next `encode` stamps them, then `commit` records it. */
  finish(): void {
    if (this.#finished) return;
    const last = this.#planner.finish();
    this.#queue(last, this.#planner.starts(), true, this.#planner.arc());
    this.#tail = new Float32Array();
    this.#finished = true;
  }

  /**
   * Adds a batch of final dabs to the pending ones. A joined batch repeats the last dab before it,
   * which is already the last pending dab when the pending ones are not stamped yet. The pending
   * dabs begin at the stroke's start when their first batch did, and end it with the last batch.
   * `arc` is the arc length of the batch's first dab.
   */
  #queue(batch: Float32Array, starts: boolean, ends: boolean, arc: number): void {
    if (this.#pendingDabs.length === 0) this.#pendingStarts = starts;
    this.#pendingEnds ||= ends;
    const skip = this.#joined && this.#pendingDabs.length > 0 && batch.length > 0 ? 3 : 0;
    for (let i = skip; i < batch.length; i++) this.#pendingDabs.push(batch[i] ?? 0);
    const arcs = this.#planner.dab_arcs(batch, arc);
    for (let i = skip / 3; i < arcs.length; i++) this.#pendingArcs.push(arcs[i] ?? 0);
  }

  /**
   * Records the pending stamping: new final dabs into the stroke slots, provisional dabs into
   * scratch copies, and every changed tile into its preview slot. Allocates before recording,
   * so no buffer or page grows under recorded commands. Call it first in a frame's encoder.
   */
  encode(encoder: GPUCommandEncoder): void {
    const { width, height } = this.#doc;
    const parts = { joined: this.#joined, square: this.#square, antialias: this.#antialias };
    const finals = planStamps(this.#pendingDabs, width, height, {
      ...parts,
      starts: this.#pendingStarts,
      ends: this.#pendingEnds,
    });
    const tails = planStamps(this.#tail, width, height, {
      ...parts,
      starts: this.#tailStarts,
      ends: true,
    });
    const finalDabs = this.#pendingDabs;
    const finalArcs = this.#pendingArcs;
    this.#pendingDabs = [];
    this.#pendingArcs = [];
    this.#pendingEnds = false;
    for (const stamp of [...finals, ...tails]) this.#tile(stamp.tx, stamp.ty);
    const tailKeys = new Set(tails.map((stamp) => this.#key(stamp.tx, stamp.ty)));
    for (const key of tailKeys) {
      const tile = this.#tiles.get(key) as Tile;
      tile.scratch ??= this.#slots.allocate();
    }
    const changed = new Set([
      ...finals.map((stamp) => this.#key(stamp.tx, stamp.ty)),
      ...tailKeys,
      ...[...this.#tiles].filter(([, tile]) => tile.tailed).map(([key]) => key),
    ]);
    if (changed.size === 0) return;

    // All slots exist now, so the slot buffer is final for this frame.
    const buffer = this.#slots.buffer;
    const fresh = [...this.#tiles.values()].filter((tile) => tile.fresh);
    for (const tile of fresh) this.#initialize(encoder, tile);

    // Each dab as centre, radius and arc length along the stroke.
    const dabs = new Float32Array((finalDabs.length / 3 + this.#tail.length / 3) * 4);
    const put = (source: ArrayLike<number>, arcs: ArrayLike<number>, base: number) => {
      for (let i = 0; i * 3 < source.length; i++) {
        const [x, y, diameter] = [source[i * 3] ?? 0, source[i * 3 + 1] ?? 0, source[i * 3 + 2]];
        dabs.set([x, y, (diameter ?? 0) * 0.5, arcs[i] ?? 0], (base + i) * 4);
      }
    };
    put(finalDabs, finalArcs, 0);
    const tailBase = finalDabs.length / 3;
    put(this.#tail, this.#planner.dab_arcs(this.#tail, this.#tailArc), tailBase);
    const tileOf = (stamp: TileStamp) => this.#tiles.get(this.#key(stamp.tx, stamp.ty)) as Tile;
    const stamps = [
      ...finals.map((stamp) => ({ stamp, slot: tileOf(stamp).final, base: 0, final: true })),
      ...tails.map((stamp) => ({
        stamp,
        slot: tileOf(stamp).scratch ?? 0,
        base: tailBase,
        final: false,
      })),
    ];
    const indices: number[] = [];
    // The stroke's terms near each stamp, which pixels where the stroke passes more than once
    // combine their passes from (brush.rs `coverage_at`).
    const candidates: Float32Array[] = [];
    let candidateCount = 0;
    const noTail = new Float32Array();
    const params = new ArrayBuffer(Math.max(1, stamps.length) * STRIDE);
    const view = new DataView(params);
    stamps.forEach(({ stamp, slot, base, final }, i) => {
      const tile = tileOf(stamp);
      const ox = stamp.tx * TILE_SIZE;
      const oy = stamp.ty * TILE_SIZE;
      const near = this.#square
        ? noTail
        : this.#planner.terms_near(
            ox + stamp.x0,
            oy + stamp.y0,
            ox + stamp.x1,
            oy + stamp.y1,
            final ? noTail : this.#tail,
            this.#tailStarts,
            this.#tailArc,
          );
      candidates.push(near);
      const words = [
        this.#slots.wordOffset(slot),
        stamp.tx * TILE_SIZE,
        stamp.ty * TILE_SIZE,
        indices.length,
        stamp.x0,
        stamp.y0,
        stamp.x1,
        stamp.y1,
        stamp.terms.length / 3,
        this.#slots.wordOffset(tile.original),
        this.#slots.wordOffset(tile.cover),
        final ? 1 : 0,
        this.#slots.wordOffset(tile.cover2),
        this.#slots.wordOffset(tile.cover3),
        this.#slots.wordOffset(tile.cover4),
        candidateCount,
        near.length / 12,
      ];
      candidateCount += near.length / 12;
      words.forEach((word, k) => {
        view.setUint32(i * STRIDE + k * 4, word, true);
      });
      for (let k = 0; k < stamp.terms.length; k += 3) {
        indices.push(
          stamp.terms[k] ?? 0,
          base + (stamp.terms[k + 1] ?? 0),
          base + (stamp.terms[k + 2] ?? 0),
        );
      }
    });
    const device = this.#device;
    const dabBuffer = this.#buffer("dabs", Math.max(16, dabs.byteLength), BufferUsage.STORAGE);
    const indexBuffer = this.#buffer(
      "indices",
      Math.max(16, indices.length * 4),
      BufferUsage.STORAGE,
    );
    const paramBuffer = this.#buffer("params", params.byteLength, BufferUsage.UNIFORM);
    device.queue.writeBuffer(dabBuffer, 0, dabs);
    device.queue.writeBuffer(indexBuffer, 0, new Uint32Array(indices));
    device.queue.writeBuffer(paramBuffer, 0, params);
    const candidateWords = new Float32Array(Math.max(12, candidateCount * 12));
    let at = 0;
    for (const near of candidates) {
      candidateWords.set(near, at);
      at += near.length;
    }
    const candidateBuffer = this.#buffer(
      "candidates",
      candidateWords.byteLength,
      BufferUsage.STORAGE,
    );
    device.queue.writeBuffer(candidateBuffer, 0, candidateWords);
    const stampGroup = device.createBindGroup({
      layout: this.#pipelines.stampLayout,
      entries: [
        { binding: 0, resource: { buffer: this.#strokeUniform } },
        { binding: 1, resource: { buffer: paramBuffer, size: TILE_PARAMS_BYTES } },
        { binding: 3, resource: { buffer: dabBuffer } },
        { binding: 4, resource: { buffer: indexBuffer } },
        { binding: 5, resource: { buffer } },
        { binding: 6, resource: { buffer: candidateBuffer } },
      ],
    });
    const dispatch = (pass: GPUComputePassEncoder, stamp: TileStamp, index: number) => {
      pass.setBindGroup(0, stampGroup, [index * STRIDE]);
      pass.dispatchWorkgroups(
        Math.ceil((stamp.x1 - stamp.x0) / 8),
        Math.ceil((stamp.y1 - stamp.y0) / 8),
      );
    };

    const shown = (tile: Tile, key: number) =>
      tailKeys.has(key) ? (tile.scratch as number) : tile.final;
    const word = (slot: number | undefined) => this.#slots.wordOffset(slot ?? 0);
    // Slot jobs: copies of final into scratch for the tail, then clips to the selection.
    const copies = [...tailKeys].map((key) => {
      const tile = this.#tiles.get(key) as Tile;
      return [0, word(tile.final), 0, word(tile.scratch)];
    });
    const resolves = this.#mask
      ? [...changed].map((key) => {
          const tile = this.#tiles.get(key) as Tile;
          return [word(tile.original), word(shown(tile, key)), word(tile.mask), word(tile.out)];
        })
      : [];
    const jobs = [...copies, ...resolves];
    let jobGroup: GPUBindGroup | undefined;
    if (jobs.length > 0) {
      const jobBuffer = this.#buffer("jobs", jobs.length * STRIDE, BufferUsage.UNIFORM);
      const data = new ArrayBuffer(jobs.length * STRIDE);
      const words = new DataView(data);
      jobs.forEach((slots, i) => {
        slots.forEach((value, k) => {
          words.setUint32(i * STRIDE + k * 4, value, true);
        });
      });
      device.queue.writeBuffer(jobBuffer, 0, data);
      jobGroup = device.createBindGroup({
        layout: this.#pipelines.resolveLayout,
        entries: [
          { binding: 0, resource: { buffer: jobBuffer, size: RESOLVE_BYTES } },
          { binding: 1, resource: { buffer } },
        ],
      });
    }
    const job = (pass: GPUComputePassEncoder, index: number) => {
      pass.setBindGroup(0, jobGroup as GPUBindGroup, [index * STRIDE]);
      pass.dispatchWorkgroups(TILE_SIZE / 8, TILE_SIZE / 8);
    };

    // One pass; WebGPU orders its dispatches and makes each one's writes visible to the next.
    const pass = encoder.beginComputePass({ label: "v2 stroke" });
    if (finals.length > 0) {
      pass.setPipeline(this.#pipelines.stamp);
      finals.forEach((stamp, i) => {
        dispatch(pass, stamp, i);
      });
    }
    if (copies.length > 0) {
      pass.setPipeline(this.#pipelines.copy);
      copies.forEach((_, i) => {
        job(pass, i);
      });
    }
    if (tails.length > 0) {
      pass.setPipeline(this.#pipelines.stamp);
      tails.forEach((stamp, i) => {
        dispatch(pass, stamp, finals.length + i);
      });
    }
    if (resolves.length > 0) {
      pass.setPipeline(this.#pipelines.resolve);
      resolves.forEach((_, i) => {
        job(pass, copies.length + i);
      });
    }
    pass.end();

    for (const key of changed) {
      const tile = this.#tiles.get(key) as Tile;
      const source = tile.out ?? shown(tile, key);
      this.#doc.pool.copyFromBuffer(encoder, buffer, this.#slots.offset(source), tile.preview);
      tile.tailed = tailKeys.has(key);
      this.#doc.changes.tileChanged(tile.tx, tile.ty);
    }
  }

  /**
   * Makes the stroke part of the layer: its preview slots become the layer's tiles, and the
   * replaced tiles are freed. Records copies of the painted tiles into a readback buffer and
   * returns a function that, after the encoder is submitted, reads them back.
   */
  commit(encoder: GPUCommandEncoder): () => Promise<StrokeTile[]> {
    const table = this.#doc.table;
    table.clearOverrides(this.layerId);
    const tiles = [...this.#tiles.values()];
    const readback = this.#device.createBuffer({
      label: "v2 stroke readback",
      size: Math.max(4, tiles.length * SLOT_BYTES),
      usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
    });
    tiles.forEach((tile, i) => {
      const replaced = table.setTile(this.layerId, tile.tx, tile.ty, tile.preview);
      if (replaced !== undefined) this.#doc.pool.free(replaced);
      this.#doc.changes.tileChanged(tile.tx, tile.ty);
      encoder.copyBufferToBuffer(
        this.#slots.buffer,
        this.#slots.offset(tile.out ?? tile.final),
        readback,
        i * SLOT_BYTES,
        SLOT_BYTES,
      );
    });
    this.#tiles.clear();
    return async () => {
      this.#release(tiles);
      try {
        await readback.mapAsync(MAP_READ_MODE);
        const bytes = new Uint8Array(readback.getMappedRange());
        return tiles.map((tile, i) => ({
          tx: tile.tx,
          ty: tile.ty,
          pixels: bytes.slice(i * SLOT_BYTES, (i + 1) * SLOT_BYTES),
        }));
      } finally {
        readback.destroy();
      }
    };
  }

  /** Drops the stroke: the layer shows its own tiles again. */
  cancel(): void {
    this.#doc.table.clearOverrides(this.layerId);
    const tiles = [...this.#tiles.values()];
    for (const tile of tiles) {
      this.#doc.pool.free(tile.preview);
      this.#doc.changes.tileChanged(tile.tx, tile.ty);
    }
    this.#tiles.clear();
    this.#release(tiles);
  }

  #release(tiles: readonly Tile[]): void {
    for (const tile of tiles) {
      for (const slot of [
        tile.final,
        tile.original,
        tile.cover,
        tile.cover2,
        tile.cover3,
        tile.cover4,
        tile.mask,
        tile.out,
        tile.scratch,
      ]) {
        if (slot !== undefined) this.#slots.free(slot);
      }
    }
    this.#planner.free();
    this.#strokeUniform.destroy();
    for (const buffer of this.#buffers.values()) buffer.destroy();
    this.#buffers.clear();
  }

  #hasTailed(): boolean {
    for (const tile of this.#tiles.values()) if (tile.tailed) return true;
    return false;
  }

  #key(tx: number, ty: number): number {
    return this.#doc.table.key(tx, ty);
  }

  /** The stroke's tile at (`tx`, `ty`), allocating its slots on first use. */
  #tile(tx: number, ty: number): Tile {
    const key = this.#key(tx, ty);
    const existing = this.#tiles.get(key);
    if (existing) return existing;
    const masked = this.#mask !== undefined;
    const tile: Tile = {
      tx,
      ty,
      final: this.#slots.allocate(),
      preview: this.#doc.allocateFor(this.layerId),
      original: this.#slots.allocate(),
      cover: this.#slots.allocate(),
      cover2: this.#slots.allocate(),
      cover3: this.#slots.allocate(),
      cover4: this.#slots.allocate(),
      mask: masked ? this.#slots.allocate() : undefined,
      out: masked ? this.#slots.allocate() : undefined,
      scratch: undefined,
      tailed: false,
      fresh: true,
    };
    this.#tiles.set(key, tile);
    this.#doc.table.setOverride(this.layerId, tx, ty, tile.preview);
    return tile;
  }

  /** Fills a new tile's slots: the layer's pixels (or transparency) and the selection coverage. */
  #initialize(encoder: GPUCommandEncoder, tile: Tile): void {
    tile.fresh = false;
    const buffer = this.#slots.buffer;
    const original = this.#doc.table.tile(this.layerId, tile.tx, tile.ty);
    for (const slot of [tile.final, tile.original]) {
      const offset = this.#slots.offset(slot);
      if (original === undefined) encoder.clearBuffer(buffer, offset, SLOT_BYTES);
      else this.#doc.pool.copyToBuffer(encoder, original, buffer, offset);
    }
    for (const slot of [tile.cover, tile.cover2, tile.cover3, tile.cover4]) {
      encoder.clearBuffer(buffer, this.#slots.offset(slot), SLOT_BYTES);
    }
    if (tile.mask !== undefined && this.#mask) {
      this.#device.queue.writeBuffer(
        buffer,
        this.#slots.offset(tile.mask),
        maskWords(this.#mask, tile.tx * TILE_SIZE, tile.ty * TILE_SIZE),
      );
    }
  }

  /** A reusable upload buffer of at least `bytes`, by purpose. */
  #buffer(name: string, bytes: number, usage: number): GPUBuffer {
    const existing = this.#buffers.get(name);
    if (existing && existing.size >= bytes) return existing;
    existing?.destroy();
    const created = this.#device.createBuffer({
      label: `v2 stroke ${name}`,
      size: 2 ** Math.ceil(Math.log2(Math.max(bytes, 256))),
      usage: usage | BufferUsage.COPY_DST,
    });
    this.#buffers.set(name, created);
    return created;
  }
}

/** The coverage of a 256 px tile at image (`ox`, `oy`), one word per pixel, 0 outside the mask. */
export function maskWords(mask: StrokeMask, ox: number, oy: number): Uint32Array<ArrayBuffer> {
  const words = new Uint32Array(TILE_SIZE * TILE_SIZE);
  const x0 = Math.max(mask.x, ox);
  const x1 = Math.min(mask.x + mask.width, ox + TILE_SIZE);
  const y0 = Math.max(mask.y, oy);
  const y1 = Math.min(mask.y + mask.height, oy + TILE_SIZE);
  for (let y = y0; y < y1; y++) {
    const row = (y - mask.y) * mask.width - mask.x;
    const out = (y - oy) * TILE_SIZE - ox;
    for (let x = x0; x < x1; x++) words[out + x] = mask.data[row + x] ?? 0;
  }
  return words;
}
