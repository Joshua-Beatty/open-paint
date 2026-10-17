/** One open image in the session. `id` is stable for as long as the image stays open. */
export interface ImageTab<T> {
  readonly id: string;
  readonly value: T;
}

/** The immutable snapshot of the strip. Each change makes a new object, so React can compare it. */
export interface ImageTabState<T> {
  readonly items: readonly ImageTab<T>[];
  readonly activeId: string | undefined;
}

/**
 * The open images in tab order, with the active one (UI-TABS-01). The rules for choosing the
 * active tab after a close, and the wrap-around of next and previous, live here so they are
 * tested without the DOM.
 */
export class ImageTabs<T> {
  #state: ImageTabState<T> = { items: [], activeId: undefined };
  #nextId = 1;
  readonly #listeners = new Set<() => void>();

  get state(): ImageTabState<T> {
    return this.#state;
  }

  get count(): number {
    return this.#state.items.length;
  }

  get active(): ImageTab<T> | undefined {
    return this.get(this.#state.activeId);
  }

  get(id: string | undefined): ImageTab<T> | undefined {
    return this.#state.items.find((item) => item.id === id);
  }

  /** Adds an image at the end and makes it active (UI-TABS-01). Returns its id. */
  open(value: T): string {
    const id = `tab-${this.#nextId++}`;
    this.#commit([...this.#state.items, { id, value }], id);
    return id;
  }

  /** Makes a tab active. Returns false when no open image has that id. */
  activate(id: string): boolean {
    if (this.get(id) === undefined) return false;
    if (id !== this.#state.activeId) this.#commit(this.#state.items, id);
    return true;
  }

  /** Activates the next tab, wrapping from the last to the first (UI-KEY-01). */
  next(): boolean {
    return this.#step(1);
  }

  /** Activates the previous tab, wrapping from the first to the last (UI-KEY-01). */
  previous(): boolean {
    return this.#step(-1);
  }

  /** Activates the tab at a 1-based position. Returns false when there is no such tab. */
  goTo(position: number): boolean {
    const tab = this.#state.items[position - 1];
    return Number.isInteger(position) && tab !== undefined && this.activate(tab.id);
  }

  /** Moves the active tab one place left or right, without wrapping (UI-TABS-01). */
  moveActive(delta: -1 | 1): boolean {
    const from = this.#indexOf(this.#state.activeId);
    if (from < 0) return false;
    return this.#move(from, from + delta);
  }

  /** Moves a tab to `index` in the final order, clamped to the strip. Returns whether it moved. */
  move(id: string, index: number): boolean {
    const from = this.#indexOf(id);
    if (from < 0) return false;
    return this.#move(from, Math.min(Math.max(0, index), this.#state.items.length - 1));
  }

  /**
   * Removes a tab. When it was active, the tab to its right becomes active, or the tab to its left
   * when it was the last one (UI-DOC-03). Returns false when no open image has that id.
   */
  close(id: string): boolean {
    const index = this.#indexOf(id);
    if (index < 0) return false;
    const items = this.#state.items.filter((item) => item.id !== id);
    let activeId = this.#state.activeId;
    if (activeId === id) {
      activeId = items[index]?.id ?? items[index - 1]?.id;
    }
    this.#commit(items, activeId);
    return true;
  }

  /** Replaces the value of an open image, such as its name after a save. Keeps its place and id. */
  replace(id: string, value: T): boolean {
    const index = this.#indexOf(id);
    if (index < 0) return false;
    const items = this.#state.items.map((item, position) =>
      position === index ? { id, value } : item,
    );
    this.#commit(items, this.#state.activeId);
    return true;
  }

  /** Calls `listener` after every change. Returns the function that stops the calls. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #step(delta: 1 | -1): boolean {
    const count = this.#state.items.length;
    if (count === 0) return false;
    const current = this.#indexOf(this.#state.activeId);
    const next = current < 0 ? 0 : (current + delta + count) % count;
    return this.activate(this.#state.items[next]?.id ?? "");
  }

  #move(from: number, to: number): boolean {
    if (to < 0 || to >= this.#state.items.length || to === from) return false;
    const items = [...this.#state.items];
    const [moved] = items.splice(from, 1);
    if (moved === undefined) return false;
    items.splice(to, 0, moved);
    this.#commit(items, this.#state.activeId);
    return true;
  }

  #indexOf(id: string | undefined): number {
    return this.#state.items.findIndex((item) => item.id === id);
  }

  #commit(items: readonly ImageTab<T>[], activeId: string | undefined): void {
    this.#state = { items, activeId };
    for (const listener of this.#listeners) listener();
  }
}
