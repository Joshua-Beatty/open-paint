/** Losses within `DEVICE_LOSS_WINDOW_MS` that force the CPU backend (WEB-GPU-05). */
export const MAX_DEVICE_LOSSES = 3;
export const DEVICE_LOSS_WINDOW_MS = 60_000;

/** Counts GPU device losses and decides between recreating the device and falling back to CPU. */
export class DeviceLossTracker {
  #recent: number[] = [];
  #total = 0;

  /** Device losses this session (for diagnostics). */
  get count(): number {
    return this.#total;
  }

  /** Records a loss at `now` (ms); returns true when the GPU backend must be abandoned. */
  record(now: number): boolean {
    this.#total++;
    this.#recent = this.#recent.filter((t) => now - t < DEVICE_LOSS_WINDOW_MS);
    this.#recent.push(now);
    return this.#recent.length >= MAX_DEVICE_LOSSES;
  }

  /** Forgets recent losses, e.g. when the user picks a backend again. */
  reset(): void {
    this.#recent = [];
  }
}
