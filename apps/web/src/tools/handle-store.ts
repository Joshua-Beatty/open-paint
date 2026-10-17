/**
 * A store of the handles one tool shows on the canvas. The canvas overlay reads it through
 * `useSyncExternalStore`, so a change redraws the handles without touching the tool.
 */
export class HandleStore<T extends object> {
  #state: T;
  readonly #listeners = new Set<() => void>();

  constructor(initial: T) {
    this.#state = initial;
  }

  get state(): T {
    return this.#state;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  set(state: T): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}
