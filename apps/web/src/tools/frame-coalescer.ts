/** Schedules a callback before the next repaint and returns a function that cancels it. */
export type ScheduleFrame = (callback: () => void) => () => void;

/**
 * Runs a tool's preview at most once per frame. Each request replaces the pending one, so a burst
 * of pointer moves draws only where the pointer ended up, never every position in between. Without
 * a scheduler (tests), requests run at once.
 */
export class FrameCoalescer {
  readonly #schedule: ScheduleFrame | undefined;
  #work: (() => void) | undefined;
  #cancel: (() => void) | undefined;

  constructor(schedule: ScheduleFrame | undefined) {
    this.#schedule = schedule;
  }

  get pending(): boolean {
    return this.#work !== undefined;
  }

  /** Runs `work` on the next frame, unless a later request replaces it first. */
  request(work: () => void): void {
    if (this.#schedule === undefined) {
      work();
      return;
    }
    this.#work = work;
    this.#cancel ??= this.#schedule(() => {
      this.#cancel = undefined;
      this.flush();
    });
  }

  /** Runs the pending work now, if any. */
  flush(): void {
    const work = this.#work;
    this.cancel();
    work?.();
  }

  /** Drops the pending work. */
  cancel(): void {
    this.#cancel?.();
    this.#cancel = undefined;
    this.#work = undefined;
  }
}
