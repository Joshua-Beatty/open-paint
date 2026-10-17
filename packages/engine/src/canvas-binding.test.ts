import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderCanvas } from "./canvas";
import { bindPresenter } from "./canvas-binding";
import { BlankPresenter, CpuPresenter, GpuPresenter } from "./presenter";

/**
 * A canvas that, like a real one, keeps the first context type it hands out and returns null for
 * any other type afterwards.
 */
class FakeCanvas {
  width = 1;
  height = 1;
  bound: string | undefined;
  readonly contexts = new Map<string, object>();

  getContext(type: string): object | null {
    if (this.bound !== undefined && this.bound !== type) return null;
    this.bound = type;
    let context = this.contexts.get(type);
    if (context === undefined) {
      context = { canvas: this, configure: vi.fn(), transferFromImageBitmap: vi.fn() };
      this.contexts.set(type, context);
    }
    return context;
  }

  transferToImageBitmap(): object {
    return {};
  }
}

/** A device whose every method returns a stub object, enough to build a GPU presenter. */
const device = new Proxy(
  {},
  {
    get: (_target, name) =>
      name === "then" ? undefined : () => ({ getBindGroupLayout: () => ({}), destroy: () => {} }),
  },
) as GPUDevice;

describe("bindPresenter", () => {
  beforeEach(() => vi.stubGlobal("OffscreenCanvas", FakeCanvas));
  afterEach(() => vi.unstubAllGlobals());

  const canvas = () => new FakeCanvas() as unknown as RenderCanvas & FakeCanvas;

  it("draws the GPU backend straight into the canvas's own WebGPU context", () => {
    const visible = canvas();
    const bound = bindPresenter(visible, device, "bgra8unorm");
    expect(bound.presenter).toBeInstanceOf(GpuPresenter);
    expect(bound.restartCanvas).toBe(false);
    expect(visible.bound).toBe("webgpu");
    // A recreated device after a loss reuses the same context.
    expect(bindPresenter(visible, device, "bgra8unorm").restartCanvas).toBe(false);
  });

  it("draws the CPU backend into the canvas's bitmap renderer", () => {
    const visible = canvas();
    const bound = bindPresenter(visible, undefined, "bgra8unorm");
    expect(bound.presenter).toBeInstanceOf(CpuPresenter);
    expect(bound.restartCanvas).toBe(false);
    expect(visible.bound).toBe("bitmaprenderer");
  });

  it("asks for a new canvas when the CPU backend follows the GPU one", () => {
    const visible = canvas();
    bindPresenter(visible, device, "bgra8unorm");
    const bound = bindPresenter(visible, undefined, "bgra8unorm");
    expect(bound.presenter).toBeInstanceOf(BlankPresenter);
    expect(bound.restartCanvas).toBe(true);
  });

  it("presents the GPU backend through a bitmap copy on a bitmap canvas, and asks for a new one", () => {
    const visible = canvas();
    bindPresenter(visible, undefined, "bgra8unorm");
    const bound = bindPresenter(visible, device, "bgra8unorm");
    expect(bound.presenter).toBeInstanceOf(GpuPresenter);
    expect(bound.restartCanvas).toBe(true);
    expect(visible.bound).toBe("bitmaprenderer");
  });
});
