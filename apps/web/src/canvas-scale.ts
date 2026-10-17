/**
 * Device pixels per CSS pixel of the engine canvas: the scale the engine renders at, measured from
 * the canvas's device-pixel content box (WEB-GPU-07). Overlays, rulers and pointer math use it
 * rather than `devicePixelRatio`, which can disagree with the canvas's real pixel size (browser
 * emulation, some multi-monitor and remote setups), so they always line up with the canvas.
 */
class CanvasScaleStore {
  #value: number | undefined;
  readonly #listeners = new Set<() => void>();

  /** The measured scale, or `devicePixelRatio` until the canvas has been measured. */
  get value(): number {
    return this.#value ?? (globalThis.devicePixelRatio || 1);
  }

  set(value: number): void {
    if (!(value > 0) || value === this.#value) return;
    this.#value = value;
    for (const listener of [...this.#listeners]) listener();
  }

  /** Forgets the measurement (tests). */
  reset(): void {
    this.#value = undefined;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
}

export const canvasScale = new CanvasScaleStore();

/**
 * The canvas scale from a resize observation of the engine canvas: its device-pixel width over
 * its CSS width, or `fallback` without a device-pixel box or a width.
 */
export function measuredScale(
  devicePixels: { readonly width: number; readonly height: number },
  css: { readonly width: number; readonly height: number },
  fallback: number,
): number {
  if (css.width > 0) return devicePixels.width / css.width;
  if (css.height > 0) return devicePixels.height / css.height;
  return fallback;
}
