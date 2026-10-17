/**
 * Canvases the engine draws into. `OffscreenCanvas` is used wherever the browser has it (Chromium,
 * Firefox). WebKit has no `OffscreenCanvas`, so there the engine uses detached HTML canvases on the
 * main thread (`startEngine` runs without a worker in that case).
 */
export type RenderCanvas = OffscreenCanvas | HTMLCanvasElement;

/**
 * The 2D context the engine draws with. An HTML canvas context has the same drawing API, so the
 * fallback is typed as this one.
 */
export type RenderContext = OffscreenCanvasRenderingContext2D;

/** A canvas of the given size, `OffscreenCanvas` when available. */
export function createRenderCanvas(width: number, height: number): RenderCanvas {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** The 2D context of a render canvas. Narrowed per type, since both sides overload `getContext`. */
export function context2d(
  canvas: RenderCanvas,
  options?: CanvasRenderingContext2DSettings,
): RenderContext | null {
  const context =
    "transferToImageBitmap" in canvas
      ? canvas.getContext("2d", options)
      : canvas.getContext("2d", options);
  return context as RenderContext | null;
}

/** The `bitmaprenderer` context of the visible canvas. */
export function bitmapContext(canvas: RenderCanvas): ImageBitmapRenderingContext | null {
  return "transferToImageBitmap" in canvas
    ? canvas.getContext("bitmaprenderer")
    : canvas.getContext("bitmaprenderer");
}

/**
 * Shows a rendered surface on the visible canvas. `transferToImageBitmap` is synchronous. The
 * HTML canvas fallback snapshots the surface with `createImageBitmap`, which resolves in call order.
 */
export function presentSurface(output: ImageBitmapRenderingContext, surface: RenderCanvas): void {
  if ("transferToImageBitmap" in surface) {
    output.transferFromImageBitmap(surface.transferToImageBitmap());
    return;
  }
  void createImageBitmap(surface).then((bitmap) => output.transferFromImageBitmap(bitmap));
}
