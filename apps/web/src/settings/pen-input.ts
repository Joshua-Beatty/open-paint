import type { SettingsStore } from "@openpaint/storage";

/** Set once a pen has been seen, so a later session knows a pen is in use before it touches the canvas. */
export const PEN_DETECTED_PATH = "penAndTablet.penDetected";

/** What the tool options need to know about pen input: whether a pen is in use, and when that changes. */
export interface PenPresence {
  readonly known: boolean;
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * Remembers whether a pen has sent a pointer event in this session (SET-DLG-06, SET-ERR-05). The
 * browser does not list attached pens, so this is the only signal the Pen & Tablet page has.
 * `known` is also true when an earlier session saw a pen (`remember`).
 */
export class PenInputTracker implements PenPresence {
  #detected = false;
  #remembered = false;
  readonly #listeners = new Set<() => void>();
  #stop: (() => void) | undefined;

  /** True once a pen has sent a pointer event in this session. */
  get detected(): boolean {
    return this.#detected;
  }

  /** True when a pen has been seen in this session or an earlier one. */
  get known(): boolean {
    return this.#detected || this.#remembered;
  }

  /** Listens to pointer events on `target` until a pen event arrives or `stop` is called. */
  start(target: EventTarget): void {
    if (this.#stop !== undefined || this.#detected) return;
    const onPointer = (event: Event) => {
      if ((event as PointerEvent).pointerType === "pen") this.#detect();
    };
    const options = { capture: true, passive: true } as const;
    target.addEventListener("pointerdown", onPointer, options);
    target.addEventListener("pointermove", onPointer, options);
    this.#stop = () => {
      target.removeEventListener("pointerdown", onPointer, options);
      target.removeEventListener("pointermove", onPointer, options);
    };
  }

  stop(): void {
    this.#stop?.();
    this.#stop = undefined;
  }

  /** Marks a pen as seen in an earlier session. `detected` stays about this session. */
  remember(): void {
    if (this.known) return;
    this.#remembered = true;
    this.#notify();
  }

  /** Called on each change of `detected` or `known`. Stable, so it can be passed to `useSyncExternalStore`. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #detect(): void {
    if (this.#detected) return;
    this.#detected = true;
    this.stop();
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

/**
 * Restores a pen seen in an earlier session from the settings, and stores the first pen seen in
 * this one. Returns a function that stops storing.
 */
export function rememberPenInput(pen: PenInputTracker, settings: SettingsStore): () => void {
  if (settings.get(PEN_DETECTED_PATH) === true) pen.remember();
  const store = () => {
    if (pen.detected && settings.get(PEN_DETECTED_PATH) !== true) {
      settings.set(PEN_DETECTED_PATH, true);
    }
  };
  store();
  return pen.subscribe(store);
}
