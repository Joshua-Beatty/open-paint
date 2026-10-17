import {
  context2d,
  createRenderCanvas,
  presentSurface,
  type RenderCanvas,
  type RenderContext,
} from "./canvas";
import { DISPLAY_TILE_SIZE, type DisplayTile, type Sampling, tileKey } from "./display-tiles";
import type { FramePlan, FrameStyle, Rgb, TileDraw } from "./frame";
import { BufferUsage, TextureUsage } from "./gpu-device";
import { presentChecked } from "./present-failures";
import { CHROME_WGSL, TILE_WGSL } from "./view-wgsl";

/**
 * Draws planned frames onto the on-screen canvas (ARC-03-02). Both backends draw the same
 * `FramePlan` (background, shadow, checkerboard, display tiles, border). The CPU backend renders
 * into a private `OffscreenCanvas` and hands the result to the visible canvas's `bitmaprenderer`
 * context. The GPU backend draws into the visible canvas's WebGPU context, which survives device
 * loss (it is configured again with the new device); since a canvas cannot change its context
 * type, moving to the other backend's context needs a new canvas (`EngineStatus.restartCanvas`).
 */
export interface Presenter {
  resize(width: number, height: number): void;
  /**
   * Draws `frame`. Throws when it cannot draw; a GPU presenter also returns a promise that rejects
   * when the GPU reports an error for the frame's commands, which only shows up later.
   */
  present(frame: FramePlan): void | Promise<void>;
  /** Releases cached drawing resources. The next `present` rebuilds whatever it needs (ARC-03-10). */
  trim(): void;
}

class SurfacePresenter {
  protected readonly surface: RenderCanvas = createRenderCanvas(1, 1);

  constructor(protected readonly output: ImageBitmapRenderingContext) {}

  resize(width: number, height: number): void {
    for (const canvas of [this.surface, this.output.canvas]) {
      canvas.width = Math.max(1, width);
      canvas.height = Math.max(1, height);
    }
  }

  protected show(): void {
    presentSurface(this.output, this.surface);
  }
}

function css([r, g, b]: Rgb): string {
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Premultiplied tile pixels as the straight-alpha bytes `ImageData` takes. Color is divided back
 * out of the coverage, so very transparent pixels lose some precision on this path only.
 */
export function straightPixels(premultiplied: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(premultiplied.length);
  for (let i = 0; i < premultiplied.length; i += 4) {
    const alpha = premultiplied[i + 3] ?? 0;
    out[i + 3] = alpha;
    if (alpha === 0) continue;
    for (let c = 0; c < 3; c++) {
      out[i + c] = Math.round(((premultiplied[i + c] ?? 0) * 255) / alpha);
    }
  }
  return out;
}

/**
 * CPU backend (ARC-03-09): the frame is drawn with Canvas 2D. Display tiles are drawn with
 * nearest-neighbor or bilinear smoothing as planned, and the result is presented as an ImageBitmap.
 */
export class CpuPresenter extends SurfacePresenter implements Presenter {
  readonly #context: RenderContext;
  #tileCanvases = new WeakMap<DisplayTile, RenderCanvas>();
  #checker: { key: string; pattern: CanvasPattern } | undefined;
  #shadow: { key: string; canvas: RenderCanvas; pad: number } | undefined;

  constructor(output: ImageBitmapRenderingContext) {
    super(output);
    const context = context2d(this.surface);
    if (!context) throw new Error("Canvas 2D is unavailable.");
    this.#context = context;
  }

  present(frame: FramePlan): void {
    const ctx = this.#context;
    const { canvas, style } = frame;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = css(style.background);
    ctx.fillRect(0, 0, this.surface.width, this.surface.height);

    this.#drawShadow(frame);

    ctx.save();
    ctx.translate(canvas.x, canvas.y);
    ctx.fillStyle = this.#checkerboard(style.checker);
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    for (const draw of frame.tiles) this.#drawTile(draw);

    if (style.border) {
      ctx.fillStyle = css(style.border);
      ctx.fillRect(canvas.x - 1, canvas.y - 1, canvas.width + 2, 1);
      ctx.fillRect(canvas.x - 1, canvas.y + canvas.height, canvas.width + 2, 1);
      ctx.fillRect(canvas.x - 1, canvas.y, 1, canvas.height);
      ctx.fillRect(canvas.x + canvas.width, canvas.y, 1, canvas.height);
    }
    this.show();
  }

  /**
   * The drop shadow, blurred once per image size and style into a cached canvas and copied from it
   * on each frame: a Canvas 2D shadow blur of the whole image every frame costs tens of
   * milliseconds where Canvas 2D runs in software (Firefox). Only the part of the image within
   * reach of the viewport casts it, so a zoomed-in image needs no huge canvas, and no shadow is
   * drawn when the image covers the viewport.
   */
  #drawShadow(frame: FramePlan): void {
    const { canvas, style } = frame;
    const { shadow } = style;
    if (shadow.alpha <= 0) return;
    const pad = Math.ceil(shadow.sigma * 3) + 2;
    const x0 = Math.max(canvas.x, -pad);
    const y0 = Math.max(canvas.y, -pad);
    const x1 = Math.min(canvas.x + canvas.width, frame.width + pad);
    const y1 = Math.min(canvas.y + canvas.height, frame.height + pad);
    if (x1 <= x0 || y1 <= y0) return;
    if (x0 <= 0 && y0 <= 0 && x1 >= frame.width && y1 >= frame.height) return;
    const width = x1 - x0;
    const height = y1 - y0;
    const key = `${width}x${height}/${shadow.color.join(",")}/${shadow.alpha}/${shadow.sigma}`;
    if (this.#shadow?.key !== key) {
      const cell = createRenderCanvas(width + 2 * pad, height + 2 * pad);
      const context = context2d(cell);
      if (!context) throw new Error("Canvas 2D is unavailable.");
      context.shadowColor = `rgba(${shadow.color.join(", ")}, ${shadow.alpha})`;
      context.shadowBlur = shadow.sigma * 2;
      context.fillStyle = "#000";
      context.fillRect(pad, pad, width, height);
      this.#shadow = { key, canvas: cell, pad };
    }
    this.#context.drawImage(this.#shadow.canvas, x0 - pad, y0 - pad);
  }

  #drawTile(draw: TileDraw): void {
    const ctx = this.#context;
    const { src, dst } = draw;
    ctx.imageSmoothingEnabled = draw.sampling === "bilinear";
    ctx.imageSmoothingQuality = "low";
    ctx.drawImage(
      this.#tileCanvas(draw.tile),
      src.x,
      src.y,
      src.width,
      src.height,
      dst.x,
      dst.y,
      dst.width,
      dst.height,
    );
  }

  trim(): void {
    this.#tileCanvases = new WeakMap();
    this.#checker = undefined;
    this.#shadow = undefined;
  }

  #tileCanvas(tile: DisplayTile): RenderCanvas {
    const existing = this.#tileCanvases.get(tile);
    if (existing) return existing;
    const canvas = createRenderCanvas(DISPLAY_TILE_SIZE, DISPLAY_TILE_SIZE);
    const context = context2d(canvas);
    if (!context) throw new Error("Canvas 2D is unavailable.");
    const image = new ImageData(straightPixels(tile.pixels), DISPLAY_TILE_SIZE, DISPLAY_TILE_SIZE);
    context.putImageData(image, 0, 0);
    this.#tileCanvases.set(tile, canvas);
    return canvas;
  }

  #checkerboard(checker: FrameStyle["checker"]): CanvasPattern {
    const key = `${checker.size}/${checker.light}/${checker.dark}`;
    if (this.#checker?.key === key) return this.#checker.pattern;
    const size = checker.size;
    const cell = createRenderCanvas(size * 2, size * 2);
    const context = context2d(cell);
    if (!context) throw new Error("Canvas 2D is unavailable.");
    context.fillStyle = css([checker.light, checker.light, checker.light]);
    context.fillRect(0, 0, size * 2, size * 2);
    context.fillStyle = css([checker.dark, checker.dark, checker.dark]);
    context.fillRect(size, 0, size, size);
    context.fillRect(0, size, size, size);
    const pattern = this.#context.createPattern(cell, "repeat");
    if (!pattern) throw new Error("The checkerboard pattern could not be created.");
    this.#checker = { key, pattern };
    return pattern;
  }
}

/** Bytes of the chrome shader's uniform: five vec4 (rect, viewport, checker, shadow, border). */
const CHROME_BYTES = 80;
/** Bytes of the tile shader's frame uniform: one vec4. */
const FRAME_BYTES = 16;
/** Floats per tile draw in the quad storage buffer: destination and source rectangles. */
const QUAD_FLOATS = 8;
/** Tile textures kept for reuse after their tiles leave the view (64 KB each). */
const MAX_SPARE_TEXTURES = 64;

/** A tile's texture on the GPU, the tile it holds now, and its bind groups per sampling. */
interface TileTexture {
  tile: DisplayTile;
  readonly texture: GPUTexture;
  readonly groups: Partial<Record<Sampling, GPUBindGroup>>;
}
const BLEND = {
  color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
} as const satisfies GPUBlendState;

/** The chrome shader's uniform: rect, viewport (size, checker, sigma), checker, shadow, border. */
export function chromeUniform(frame: FramePlan): Float32Array {
  const { canvas, style } = frame;
  const { checker, shadow, border } = style;
  return new Float32Array([
    canvas.x,
    canvas.y,
    canvas.width,
    canvas.height,
    frame.width,
    frame.height,
    checker.size,
    shadow.sigma,
    checker.light,
    checker.dark,
    0,
    0,
    ...shadow.color.map((c) => c / 255),
    shadow.alpha,
    ...(border ? [...border.map((c) => c / 255), 1] : [0, 0, 0, 0]),
  ]);
}

/** The quad storage entry for one tile draw: destination pixels and source UVs. */
export function tileQuad(draw: TileDraw): number[] {
  const { src, dst } = draw;
  const size = DISPLAY_TILE_SIZE;
  return [
    dst.x,
    dst.y,
    dst.width,
    dst.height,
    src.x / size,
    src.y / size,
    (src.x + src.width) / size,
    (src.y + src.height) / size,
  ];
}

/** The WebGPU context of `canvas`, or null when it is bound to another context type. */
export function webgpuContext(canvas: RenderCanvas): GPUCanvasContext | null {
  try {
    return (
      "transferToImageBitmap" in canvas ? canvas.getContext("webgpu") : canvas.getContext("webgpu")
    ) as GPUCanvasContext | null;
  } catch {
    return null;
  }
}

/**
 * The context's texture for this frame. Firefox drops an `OffscreenCanvas`'s WebGPU configuration
 * when `transferToImageBitmap` takes its frame, so the context is configured again whenever it
 * reports no configuration (or, without `getConfiguration`, refuses with `InvalidStateError`).
 */
export function currentTexture(
  context: GPUCanvasContext,
  configuration: GPUCanvasConfiguration,
): GPUTexture {
  const { getConfiguration } = context as { getConfiguration?: () => unknown };
  if (getConfiguration && getConfiguration.call(context) === null) {
    context.configure(configuration);
  }
  try {
    return context.getCurrentTexture();
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "InvalidStateError")) throw error;
    context.configure(configuration);
    return context.getCurrentTexture();
  }
}

/**
 * Where a GPU presenter draws. `direct`: straight into the WebGPU context of the visible canvas.
 * `bitmap`: into a private canvas whose frames go to the visible canvas's `bitmaprenderer`, which
 * Firefox pays for with a synchronous GPU readback per frame (`transferToImageBitmap`), so it is
 * used only when the visible canvas is already bound to a bitmap renderer.
 */
export type GpuPresentTarget =
  | { readonly kind: "direct"; readonly canvas: RenderCanvas; readonly context: GPUCanvasContext }
  | { readonly kind: "bitmap"; readonly output: ImageBitmapRenderingContext };

/**
 * Draws nothing. It stands in on a canvas bound to WebGPU when the engine moves to the CPU backend,
 * until the page replaces the canvas (`EngineStatus.restartCanvas`).
 */
export class BlankPresenter implements Presenter {
  resize(): void {}
  present(): void {}
  trim(): void {}
}

/**
 * GPU backend: the chrome and the display tiles are drawn with WebGPU into a WebGPU context, the
 * visible canvas's own when it can have one (`GpuPresentTarget`). Each tile is uploaded once as a
 * premultiplied `rgba8unorm` texture and reused while the same tile object stays in the cache.
 * Textures no longer in view are released.
 */
export class GpuPresenter implements Presenter {
  /** The canvases sized with the view: the visible one, and the private one on the bitmap path. */
  readonly #canvases: readonly RenderCanvas[];
  /** Hands the private canvas's frame to the visible one; undefined when drawing directly. */
  readonly #show: (() => void) | undefined;
  readonly #device: GPUDevice;
  readonly #context: GPUCanvasContext;
  readonly #configuration: GPUCanvasConfiguration;
  readonly #chromePipeline: GPURenderPipeline;
  readonly #tilePipeline: GPURenderPipeline;
  readonly #chromeBuffer: GPUBuffer;
  readonly #frameBuffer: GPUBuffer;
  readonly #samplers: Record<Sampling, GPUSampler>;
  readonly #textures = new Map<string, TileTexture>();
  /** Textures of tiles that left the view, reused before new ones are created. */
  readonly #spare: GPUTexture[] = [];
  #quads: GPUBuffer;
  #quadCapacity = 1;

  constructor(target: GpuPresentTarget, device: GPUDevice, format: GPUTextureFormat) {
    let context: GPUCanvasContext | null;
    if (target.kind === "direct") {
      context = target.context;
      this.#canvases = [target.canvas];
      this.#show = undefined;
    } else {
      const { output } = target;
      const surface = createRenderCanvas(1, 1);
      context = webgpuContext(surface);
      this.#canvases = [surface, output.canvas];
      this.#show = () => presentSurface(output, surface);
    }
    if (!context) throw new Error("WebGPU canvas context is unavailable.");
    this.#configuration = { device, format, alphaMode: "premultiplied" };
    context.configure(this.#configuration);
    this.#device = device;
    this.#context = context;

    const chrome = device.createShaderModule({ label: "view chrome", code: CHROME_WGSL });
    this.#chromePipeline = device.createRenderPipeline({
      label: "view chrome",
      layout: "auto",
      vertex: { module: chrome, entryPoint: "chrome_vs" },
      fragment: { module: chrome, entryPoint: "chrome_fs", targets: [{ format, blend: BLEND }] },
      primitive: { topology: "triangle-list" },
    });
    const tile = device.createShaderModule({ label: "view tile", code: TILE_WGSL });
    this.#tilePipeline = device.createRenderPipeline({
      label: "view tile",
      layout: "auto",
      vertex: { module: tile, entryPoint: "tile_vs" },
      fragment: { module: tile, entryPoint: "tile_fs", targets: [{ format, blend: BLEND }] },
      primitive: { topology: "triangle-list" },
    });
    this.#chromeBuffer = device.createBuffer({
      label: "view chrome uniform",
      size: CHROME_BYTES,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    this.#frameBuffer = device.createBuffer({
      label: "view frame uniform",
      size: FRAME_BYTES,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    this.#samplers = {
      nearest: device.createSampler({ magFilter: "nearest", minFilter: "nearest" }),
      bilinear: device.createSampler({ magFilter: "linear", minFilter: "linear" }),
    };
    this.#quads = this.#createQuads(this.#quadCapacity);
  }

  present(frame: FramePlan): Promise<void> {
    return presentChecked(this.#device, () => this.#present(frame));
  }

  resize(width: number, height: number): void {
    for (const canvas of this.#canvases) {
      canvas.width = Math.max(1, width);
      canvas.height = Math.max(1, height);
    }
  }

  #present(frame: FramePlan): void {
    const device = this.#device;
    const { width, height } = this.#canvases[0] as RenderCanvas;
    const bg = frame.style.background;
    device.queue.writeBuffer(this.#chromeBuffer, 0, chromeUniform(frame));
    device.queue.writeBuffer(this.#frameBuffer, 0, new Float32Array([width, height, 0, 0]));
    this.#ensureQuads(frame.tiles.length);
    if (frame.tiles.length > 0) {
      const quads = frame.tiles.flatMap((draw) => tileQuad(draw));
      device.queue.writeBuffer(this.#quads, 0, new Float32Array(quads));
    }
    const groups = frame.tiles.map((draw) => this.#tileGroup(draw));
    this.#releaseUnused(
      new Set(frame.tiles.map((draw) => tileKey(draw.tile.level, draw.tile.tx, draw.tile.ty))),
    );

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: currentTexture(this.#context, this.#configuration).createView(),
          clearValue: { r: bg[0] / 255, g: bg[1] / 255, b: bg[2] / 255, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(this.#chromePipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: this.#chromePipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.#chromeBuffer } }],
      }),
    );
    pass.draw(3);

    pass.setPipeline(this.#tilePipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: this.#tilePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.#frameBuffer } },
          { binding: 1, resource: { buffer: this.#quads } },
        ],
      }),
    );
    groups.forEach((group, i) => {
      pass.setBindGroup(1, group);
      pass.draw(6, 1, 0, i);
    });
    pass.end();
    device.queue.submit([encoder.finish()]);
    this.#show?.();
  }

  trim(): void {
    this.#releaseUnused(new Set(), false);
    for (const texture of this.#spare.splice(0)) texture.destroy();
  }

  #createQuads(draws: number): GPUBuffer {
    return this.#device.createBuffer({
      label: "view tile quads",
      size: draws * QUAD_FLOATS * 4,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
    });
  }

  #ensureQuads(draws: number): void {
    if (draws <= this.#quadCapacity) return;
    this.#quads.destroy();
    this.#quadCapacity = Math.max(draws, this.#quadCapacity * 2);
    this.#quads = this.#createQuads(this.#quadCapacity);
  }

  /**
   * The bind group of a tile draw. A tile's texture is uploaded when the tile first shows or its
   * content changed (a new tile object), into the texture its position already had or a spare one,
   * so edits and pans do not create and destroy textures every frame. Bind groups are kept per
   * texture and sampling.
   */
  #tileGroup(draw: TileDraw): GPUBindGroup {
    const { tile } = draw;
    const key = tileKey(tile.level, tile.tx, tile.ty);
    let entry = this.#textures.get(key);
    if (!entry) {
      entry = { tile, texture: this.#spare.pop() ?? this.#createTileTexture(), groups: {} };
      this.#textures.set(key, entry);
      this.#upload(entry.texture, tile);
    } else if (entry.tile !== tile) {
      entry.tile = tile;
      this.#upload(entry.texture, tile);
    }
    const cached = entry.groups[draw.sampling];
    if (cached) return cached;
    const group = this.#device.createBindGroup({
      layout: this.#tilePipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: entry.texture.createView() },
        { binding: 1, resource: this.#samplers[draw.sampling] },
      ],
    });
    entry.groups[draw.sampling] = group;
    return group;
  }

  #createTileTexture(): GPUTexture {
    const size = DISPLAY_TILE_SIZE;
    return this.#device.createTexture({
      label: "view tile",
      size: [size, size],
      format: "rgba8unorm",
      usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
    });
  }

  #upload(texture: GPUTexture, tile: DisplayTile): void {
    const size = DISPLAY_TILE_SIZE;
    this.#device.queue.writeTexture({ texture }, tile.pixels, { bytesPerRow: size * 4 }, [
      size,
      size,
    ]);
  }

  /** Tiles out of view give their textures to the spares, up to `MAX_SPARE_TEXTURES`. */
  #releaseUnused(inView: ReadonlySet<string>, keepSpares = true): void {
    for (const [key, entry] of this.#textures) {
      if (inView.has(key)) continue;
      if (keepSpares && this.#spare.length < MAX_SPARE_TEXTURES) this.#spare.push(entry.texture);
      else entry.texture.destroy();
      this.#textures.delete(key);
    }
  }
}
