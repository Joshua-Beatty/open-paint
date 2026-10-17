import type { FramePlan, FrameStyle } from "../frame";
import { BufferUsage } from "../gpu-device";
import { chromeUniform, currentTexture } from "../presenter";
import { CHROME_WGSL } from "../view-wgsl";
import type { CompositePlan } from "./composite-plan";
import { PRESENT_V2_WGSL } from "./wgsl";

const CHROME_BYTES = 80;
const FRAME_BYTES = 16;
/** Floats per draw in the quad buffer: destination rectangle, then the slot and the image's cover. */
const QUAD_FLOATS = 8;
const BLEND = {
  color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
} as const satisfies GPUBlendState;

/**
 * Draws a v2 frame straight into the WebGPU context of the on-screen canvas: the
 * chrome (background, shadow, checkerboard, border), then the cached composite tiles,
 * clipped to the image. There is no `bitmaprenderer` hop.
 */
export class PresenterV2 {
  readonly #device: GPUDevice;
  readonly #context: GPUCanvasContext;
  readonly #configuration: GPUCanvasConfiguration;
  readonly #chromePipeline: GPURenderPipeline;
  readonly #tilePipeline: GPURenderPipeline;
  readonly #chromeBuffer: GPUBuffer;
  readonly #frameBuffer: GPUBuffer;
  readonly #samplers: { nearest: GPUSampler; bilinear: GPUSampler };
  #quads: GPUBuffer;
  #quadCapacity = 16;

  constructor(device: GPUDevice, context: GPUCanvasContext, format: GPUTextureFormat) {
    this.#device = device;
    this.#context = context;
    this.#configuration = { device, format, alphaMode: "premultiplied" };
    context.configure(this.#configuration);
    const chrome = device.createShaderModule({ label: "v2 chrome", code: CHROME_WGSL });
    this.#chromePipeline = device.createRenderPipeline({
      label: "v2 chrome",
      layout: "auto",
      vertex: { module: chrome, entryPoint: "chrome_vs" },
      fragment: { module: chrome, entryPoint: "chrome_fs", targets: [{ format, blend: BLEND }] },
      primitive: { topology: "triangle-list" },
    });
    const tile = device.createShaderModule({ label: "v2 present", code: PRESENT_V2_WGSL });
    this.#tilePipeline = device.createRenderPipeline({
      label: "v2 present",
      layout: "auto",
      vertex: { module: tile, entryPoint: "tile_vs" },
      fragment: { module: tile, entryPoint: "tile_fs", targets: [{ format, blend: BLEND }] },
      primitive: { topology: "triangle-list" },
    });
    this.#chromeBuffer = device.createBuffer({
      label: "v2 chrome uniform",
      size: CHROME_BYTES,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    this.#frameBuffer = device.createBuffer({
      label: "v2 frame uniform",
      size: FRAME_BYTES,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    this.#samplers = {
      nearest: device.createSampler({ magFilter: "nearest", minFilter: "nearest" }),
      bilinear: device.createSampler({ magFilter: "linear", minFilter: "linear" }),
    };
    this.#quads = this.#createQuads(this.#quadCapacity);
  }

  /** Records the frame's render pass. `slots` holds each draw's composite slot. */
  encode(
    encoder: GPUCommandEncoder,
    plan: CompositePlan,
    style: FrameStyle,
    tiles: GPUTextureView | undefined,
    slots: readonly number[],
  ): void {
    const device = this.#device;
    const target = currentTexture(this.#context, this.#configuration);
    const { width, height } = target;
    const frame = {
      width: plan.width,
      height: plan.height,
      zoom: plan.zoom,
      canvas: plan.canvas,
      style,
      tiles: [],
      wanted: [],
    } satisfies FramePlan;
    device.queue.writeBuffer(this.#chromeBuffer, 0, chromeUniform(frame));
    device.queue.writeBuffer(this.#frameBuffer, 0, new Float32Array([width, height, 0, 0]));
    const draws = plan.draws;
    if (draws.length > this.#quadCapacity) {
      this.#quads.destroy();
      this.#quadCapacity = Math.max(draws.length, this.#quadCapacity * 2);
      this.#quads = this.#createQuads(this.#quadCapacity);
    }
    if (draws.length > 0) {
      const quads = new Float32Array(draws.length * QUAD_FLOATS);
      draws.forEach((draw, i) => {
        const { dst, cover } = draw;
        quads.set(
          [dst.x, dst.y, dst.width, dst.height, slots[i] ?? 0, cover.x, cover.y, 0],
          i * QUAD_FLOATS,
        );
      });
      device.queue.writeBuffer(this.#quads, 0, quads);
    }

    const bg = style.background;
    const pass = encoder.beginRenderPass({
      label: "v2 present",
      colorAttachments: [
        {
          view: target.createView(),
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
    const clip = clipRect(plan.canvas, width, height);
    if (tiles && draws.length > 0 && clip) {
      pass.setScissorRect(clip.x, clip.y, clip.width, clip.height);
      pass.setPipeline(this.#tilePipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: this.#tilePipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.#frameBuffer } },
            { binding: 1, resource: { buffer: this.#quads } },
            { binding: 2, resource: tiles },
            { binding: 3, resource: this.#samplers[plan.sampling] },
          ],
        }),
      );
      pass.draw(6, draws.length);
    }
    pass.end();
  }

  destroy(): void {
    this.#chromeBuffer.destroy();
    this.#frameBuffer.destroy();
    this.#quads.destroy();
  }

  #createQuads(draws: number): GPUBuffer {
    return this.#device.createBuffer({
      label: "v2 present quads",
      size: draws * QUAD_FLOATS * 4,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
    });
  }
}

/** The image rectangle clipped to the target, or undefined when nothing of it is visible. */
function clipRect(
  canvas: { x: number; y: number; width: number; height: number },
  width: number,
  height: number,
) {
  const x0 = Math.max(0, Math.floor(canvas.x));
  const y0 = Math.max(0, Math.floor(canvas.y));
  const x1 = Math.min(width, Math.ceil(canvas.x + canvas.width));
  const y1 = Math.min(height, Math.ceil(canvas.y + canvas.height));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : undefined;
}
