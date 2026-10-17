import { bitmapContext, type RenderCanvas } from "./canvas";
import {
  BlankPresenter,
  CpuPresenter,
  GpuPresenter,
  type Presenter,
  webgpuContext,
} from "./presenter";

export interface BoundPresenter {
  readonly presenter: Presenter;
  /** The canvas holds the other backend's context, so a new canvas would present better. */
  readonly restartCanvas: boolean;
}

/**
 * The engine v1 presenter for the visible `canvas`: the GPU backend (`device`) draws into the
 * canvas's own WebGPU context, the CPU backend into its bitmap renderer. The first one asked for
 * binds the canvas for good. After that, the GPU backend falls back to drawing through a private
 * canvas and a bitmap copy, and the CPU backend cannot draw at all; both report `restartCanvas`.
 */
export function bindPresenter(
  canvas: RenderCanvas,
  device: GPUDevice | undefined,
  format: GPUTextureFormat,
): BoundPresenter {
  if (device === undefined) {
    const output = bitmapContext(canvas);
    if (output) return { presenter: new CpuPresenter(output), restartCanvas: false };
    return { presenter: new BlankPresenter(), restartCanvas: true };
  }
  const context = webgpuContext(canvas);
  if (context) {
    const target = { kind: "direct", canvas, context } as const;
    return { presenter: new GpuPresenter(target, device, format), restartCanvas: false };
  }
  const output = bitmapContext(canvas);
  if (!output) throw new Error("The canvas has neither a WebGPU context nor a bitmap renderer.");
  return {
    presenter: new GpuPresenter({ kind: "bitmap", output }, device, format),
    restartCanvas: true,
  };
}
