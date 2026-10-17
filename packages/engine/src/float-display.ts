import { intersectRects, type Rect, rect, type Size, Surface } from "@openpaint/document";
import { activeLayers, type CompositeDocument, type CompositeLayer } from "./composite";
import { compositeCpu } from "./composite-cpu";
import { BLEND_WGSL } from "./composite-wgsl";
import type { FloatLayer } from "./document-sync";
import { TextureUsage } from "./gpu-device";
import { FLOAT_MIP_WGSL, FloatGpu, floatFits } from "./gpu-float";
import type { EngineStatus } from "./protocol";

/** DOC-BLD-01 Normal. */
const NORMAL = 0;

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

/**
 * Blends the float's layer at one mip level for display: the layers under it (one composite), the
 * float with its layer's blend mode and opacity, and the layers above (one composite, Normal), with
 * the WGSL twin of the reference blend, then premultiplies for the presenter.
 */
const DISPLAY_WGSL = /* wgsl */ `
struct Stack {
  mode: u32,
  opacity: u32,
  flags: u32,
  level: u32,
}

@group(0) @binding(0) var<uniform> stack: Stack;
@group(0) @binding(1) var float_tex: texture_2d<f32>;
@group(0) @binding(2) var under_tex: texture_2d<f32>;
@group(0) @binding(3) var over_tex: texture_2d<f32>;
@group(0) @binding(4) var out_tex: texture_storage_2d<rgba8unorm, write>;

${BLEND_WGSL}
fn to_u8(t: vec4f) -> vec4u {
  return vec4u(round(t * 255.0));
}

@compute @workgroup_size(8, 8)
fn display_main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(out_tex);
  if (id.x >= size.x || id.y >= size.y) {
    return;
  }
  let p = vec2i(id.xy);
  var d = vec4u(0u);
  if ((stack.flags & 1u) != 0u) {
    d = to_u8(textureLoad(under_tex, p, stack.level));
  }
  d = composite_pixel(d, to_u8(textureLoad(float_tex, p, stack.level)), stack.mode, stack.opacity);
  if ((stack.flags & 2u) != 0u) {
    d = composite_pixel(d, to_u8(textureLoad(over_tex, p, stack.level)), 0u, 255u);
  }
  let o = vec4f(d) / 255.0;
  textureStore(out_tex, p, vec4f(o.rgb * o.a, o.a));
}
`;

/** What the presenter draws over the display tiles: a texture over a region of the image. */
export interface PresentOverlay {
  /** Premultiplied RGBA8; its pixels cover `region` evenly. */
  readonly texture: GPUTexture;
  /** The image rectangle the texture covers, in image pixels. */
  readonly region: Rect;
}

interface StackImage {
  readonly key: string;
  readonly texture: GPUTexture | undefined;
}

/**
 * Floating content on engine v1 (TL-MOVE-PIX-01). The layers under and above the float's layer do
 * not change during a drag, so each is composited once on the CPU over the float's region and kept
 * on the GPU with a mip chain; each placement is drawn on the GPU (`FloatGpu`) and blended with them
 * at the view's mip level into a texture the presenter draws over the display tiles. Nothing is read
 * back and the display tiles are not rebuilt during the drag.
 */
export class FloatDisplay {
  readonly #device: GPUDevice;
  readonly #float: FloatGpu;
  readonly #pipeline: GPUComputePipeline;
  readonly #mipPipeline: GPUComputePipeline;
  readonly #uniform: GPUBuffer;
  #under: StackImage | undefined;
  #over: StackImage | undefined;
  #standIn: GPUTexture | undefined;
  #display: GPUTexture | undefined;
  /** What the display texture shows: the float, the stack images and the level. */
  #shown: { float: FloatLayer; under: StackImage; over: StackImage; level: number } | undefined;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#float = new FloatGpu(device);
    const pipeline = (label: string, code: string, entryPoint: string) =>
      device.createComputePipeline({
        label,
        layout: "auto",
        compute: { module: device.createShaderModule({ label, code }), entryPoint },
      });
    this.#pipeline = pipeline("float display", DISPLAY_WGSL, "display_main");
    this.#mipPipeline = pipeline("float stack mip", FLOAT_MIP_WGSL, "mip_main");
    this.#uniform = device.createBuffer({ label: "float display", size: 16, usage: 0x40 | 0x8 });
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
   * The overlay that shows `float` over `doc` at mip `level`, drawn again only when the float, the
   * stack or the level changed. `doc` must be supported (`supports`).
   */
  overlay(doc: CompositeDocument, float: FloatLayer, level: number): PresentOverlay {
    const device = this.#device;
    const region = float.base.region;
    const layer = doc.layers[float.index] as CompositeLayer;
    const under = this.#stackImage(
      this.#under,
      doc,
      region,
      "under",
      (index) => index < float.index,
    );
    const over = this.#stackImage(this.#over, doc, region, "over", (index) => index > float.index);
    this.#under = under;
    this.#over = over;
    const shown = this.#shown;
    const floatChanged = shown?.float !== float;
    const atLevel = Math.min(level, this.#levels(region) - 1);
    if (
      shown !== undefined &&
      !floatChanged &&
      shown.under === under &&
      shown.over === over &&
      shown.level === atLevel &&
      this.#display !== undefined
    ) {
      return { texture: this.#display, region };
    }
    const encoder = device.createCommandEncoder({ label: "float display" });
    if (floatChanged) this.#float.encode(encoder, float, doc);
    const width = Math.max(1, region.width >> atLevel);
    const height = Math.max(1, region.height >> atLevel);
    if (this.#display?.width !== width || this.#display.height !== height) {
      this.#display?.destroy();
      this.#display = device.createTexture({
        label: "float display",
        size: [width, height],
        format: "rgba8unorm",
        usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING,
      });
    }
    const visible = layer.visible && layer.opacity > 0;
    const flags = (under.texture ? 1 : 0) | (over.texture ? 2 : 0);
    device.queue.writeBuffer(
      this.#uniform,
      0,
      new Uint32Array([layer.mode, visible ? layer.opacity : 0, flags, atLevel]),
    );
    const pass = encoder.beginComputePass({ label: "float display" });
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: this.#pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.#uniform } },
          { binding: 1, resource: (this.#float.texture as GPUTexture).createView() },
          { binding: 2, resource: (under.texture ?? this.#standInFor()).createView() },
          { binding: 3, resource: (over.texture ?? this.#standInFor()).createView() },
          { binding: 4, resource: this.#display.createView() },
        ],
      }),
    );
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
    device.queue.submit([encoder.finish()]);
    this.#shown = { float, under, over, level: atLevel };
    return { texture: this.#display, region };
  }

  /** Releases the stack images, e.g. when no float is shown any more. The float stays cached. */
  release(): void {
    for (const image of [this.#under, this.#over]) image?.texture?.destroy();
    this.#under = this.#over = undefined;
    this.#shown = undefined;
  }

  destroy(): void {
    this.release();
    this.#float.destroy();
    this.#display?.destroy();
    this.#standIn?.destroy();
    this.#uniform.destroy();
    this.#display = this.#standIn = undefined;
  }

  #levels(region: Size): number {
    return Math.min(
      9,
      Math.floor(Math.log2(Math.max(1, Math.min(region.width, region.height)))) + 1,
    );
  }

  /**
   * The composite of the layers `pick` selects over `region`, uploaded with a mip chain, kept while
   * the stack and the region stay; undefined texture when no active layer is picked.
   */
  #stackImage(
    held: StackImage | undefined,
    doc: CompositeDocument,
    region: Rect,
    label: string,
    pick: (index: number) => boolean,
  ): StackImage {
    const picked = doc.layers.filter((_, index) => pick(index));
    const key = `${region.x},${region.y},${region.width},${region.height}`;
    if (held !== undefined && held.key === key && this.#sameStack(held, picked)) return held;
    held?.texture?.destroy();
    const sub: CompositeDocument = { width: doc.width, height: doc.height, layers: picked };
    const image: StackImage = {
      key,
      texture: activeLayers(sub).length === 0 ? undefined : this.#upload(sub, region, label),
    };
    this.#stacks.set(image, picked);
    return image;
  }

  readonly #stacks = new WeakMap<StackImage, readonly CompositeLayer[]>();

  #sameStack(image: StackImage, layers: readonly CompositeLayer[]): boolean {
    const held = this.#stacks.get(image);
    return (
      held !== undefined &&
      held.length === layers.length &&
      held.every((layer, i) => layer === layers[i])
    );
  }

  #upload(sub: CompositeDocument, region: Rect, label: string): GPUTexture {
    const device = this.#device;
    const inside = intersectRects(region, rect(0, 0, sub.width, sub.height));
    const pixels = new Surface(region.width, region.height);
    const composite = compositeCpu(sub, inside);
    pixels.copyFrom(composite, composite.bounds, inside.x - region.x, inside.y - region.y);
    const texture = device.createTexture({
      label: `float ${label}`,
      size: [region.width, region.height],
      format: "rgba8unorm",
      mipLevelCount: this.#levels(region),
      usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture },
      pixels.data as Uint8ClampedArray<ArrayBuffer>,
      { bytesPerRow: region.width * 4 },
      [region.width, region.height],
    );
    const encoder = device.createCommandEncoder({ label: `float ${label} mips` });
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.#mipPipeline);
    for (let level = 1; level < texture.mipLevelCount; level++) {
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: this.#mipPipeline.getBindGroupLayout(0),
          entries: [
            {
              binding: 0,
              resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }),
            },
            { binding: 1, resource: texture.createView({ baseMipLevel: level, mipLevelCount: 1 }) },
          ],
        }),
      );
      const width = Math.max(1, region.width >> level);
      const height = Math.max(1, region.height >> level);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
    return texture;
  }

  /** A 1 px texture bound where a stack image is absent; the shader's flags skip reading it. */
  #standInFor(): GPUTexture {
    this.#standIn ??= this.#device.createTexture({
      label: "float no stack",
      size: [1, 1],
      format: "rgba8unorm",
      usage: TextureUsage.TEXTURE_BINDING,
    });
    return this.#standIn;
  }
}
