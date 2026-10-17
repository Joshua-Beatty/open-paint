/**
 * Failed presents in a row after which the GPU canvas counts as broken and the engine moves to the
 * CPU backend, as after repeated device loss (WEB-GPU-05). Each failure retries on the next frame,
 * so a single transient error never counts as a broken canvas.
 */
export const MAX_PRESENT_FAILURES = 3;

/**
 * Tells a canvas that cannot present (configure, `getCurrentTexture` or submit throwing, or a
 * validation error on every frame) from a transient error: only `MAX_PRESENT_FAILURES` failures
 * with no successful present between them count.
 */
export class PresentFailureTracker {
  #streak = 0;
  #total = 0;

  /** Failed presents this session (for diagnostics). */
  get count(): number {
    return this.#total;
  }

  /** Whether the last present failed. */
  get failing(): boolean {
    return this.#streak > 0;
  }

  /** Records a failed present; returns true when presenting on the GPU must be abandoned. */
  failed(): boolean {
    this.#total++;
    this.#streak++;
    return this.#streak >= MAX_PRESENT_FAILURES;
  }

  /** Records a present that reached the canvas, which ends the streak. */
  succeeded(): void {
    this.#streak = 0;
  }

  /** Forgets the streak, e.g. on a new device or when the user picks a backend again. */
  reset(): void {
    this.#streak = 0;
  }
}

/**
 * Passes the GPU errors no error scope caught on `device` to `report`, which would otherwise only
 * reach the worker's console.
 */
export function watchUncapturedErrors(device: GPUDevice, report: (error: unknown) => void): void {
  if (typeof device.addEventListener !== "function") return;
  device.addEventListener("uncapturederror", (event) => {
    const { error } = event as GPUUncapturedErrorEvent;
    report(new Error(`Uncaptured GPU error: ${error.message}`));
  });
}

/** The error of the `?gpu-fault=present` test hook, which makes every GPU present fail. */
export function presentFault(): Error {
  return new Error("GPU present failed (gpu-fault test hook).");
}

/**
 * Runs `present` inside a validation error scope on `device`. Throws what `present` throws;
 * the returned promise rejects when the GPU reported a validation error for the frame's commands.
 */
export function presentChecked(device: GPUDevice, present: () => void): Promise<void> {
  device.pushErrorScope("validation");
  try {
    present();
  } catch (error) {
    void device.popErrorScope().catch(() => null);
    throw error;
  }
  return device.popErrorScope().then((error) => {
    if (error) throw new Error(`GPU present failed: ${error.message}`);
  });
}
