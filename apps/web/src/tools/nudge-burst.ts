/** TL-MOVE-01: repeated arrow nudges within this many milliseconds merge into one edit. */
export const NUDGE_MERGE_MS = 500;

/**
 * The nudge of an arrow key, of Ctrl with an arrow key (TL-MOVE-01), and of Shift with an arrow
 * key (owner request: a bigger step than Ctrl).
 */
export const NUDGE_STEP = 1;
export const NUDGE_LARGE_STEP = 10;
export const NUDGE_HUGE_STEP = 50;

/** The nudge step in image pixels for an arrow key with these modifiers. Shift wins over Ctrl. */
export function nudgeStep(modifiers: { readonly ctrlKey: boolean; readonly shiftKey: boolean }) {
  if (modifiers.shiftKey) return NUDGE_HUGE_STEP;
  return modifiers.ctrlKey ? NUDGE_LARGE_STEP : NUDGE_STEP;
}

/** The offset in image pixels of an arrow key's nudge of `step` pixels (`nudgeStep`). */
export function nudgeOffset(
  dx: number,
  dy: number,
  step: number,
): { readonly dx: number; readonly dy: number } {
  return { dx: dx * step, dy: dy * step };
}

/** The bursts with nudges not recorded yet, so Undo and Redo can record them first. */
const unsettled = new Set<NudgeBurst>();

/** Records every nudge burst still waiting to merge. Undo and Redo call it first. */
export function settleNudges(): void {
  for (const burst of [...unsettled]) burst.flush();
}

/**
 * A burst of arrow nudges (TL-MOVE-01). Each nudge is drawn at once by its tool; the burst records
 * one step once no nudge follows for NUDGE_MERGE_MS, or as soon as the tool does anything else
 * (`flush`).
 */
export class NudgeBurst {
  readonly #record: () => void;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pending = false;

  constructor(record: () => void) {
    this.#record = record;
  }

  /** Whether nudges are drawn but not recorded yet. */
  get pending(): boolean {
    return this.#pending;
  }

  /** A nudge was drawn: the burst records once the nudges stop. */
  nudged(): void {
    this.#pending = true;
    unsettled.add(this);
    this.#clear();
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.flush();
    }, NUDGE_MERGE_MS);
  }

  /** Records the waiting nudges now, if any. */
  flush(): void {
    this.#clear();
    if (!this.#pending) return;
    this.#pending = false;
    unsettled.delete(this);
    this.#record();
  }

  /** Forgets the waiting nudges without recording them. */
  cancel(): void {
    this.#clear();
    this.#pending = false;
    unsettled.delete(this);
  }

  #clear(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
