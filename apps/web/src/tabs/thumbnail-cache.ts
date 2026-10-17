/**
 * Anything whose changes can be listened to, such as a `Document`. A `"preview"` change only
 * rewrote pixels for a live preview: it renews the thumbnail but changes nothing else the tab shows.
 * A `"selection"` change is a selection preview, which changes nothing the tab shows.
 */
export interface ThumbnailSource {
  subscribe(listener: (change?: "state" | "preview" | "selection") => void): () => void;
}

export interface ThumbnailCacheOptions<T extends ThumbnailSource> {
  /**
   * Draws the thumbnail as a data URL. It returns undefined when nothing can be drawn. It may take
   * several turns of the event loop. One image renders one thumbnail at a time.
   */
  readonly render: (source: T) => string | undefined | Promise<string | undefined>;
  /**
   * Called on every change of a tracked source except live previews (which come once per frame
   * while drawing), and whenever a thumbnail is renewed.
   */
  readonly onChange: () => void;
  /** The shortest time between two renders of one image (UI-TABS-01 throttling). */
  readonly intervalMs: number;
  /**
   * True while the user drags on the canvas or an effect renders. Renders due then wait another
   * interval, so thumbnails never compete with a stroke or a preview (L8).
   */
  readonly busy?: () => boolean;
}

interface Entry<T> {
  readonly source: T;
  unsubscribe: () => void;
  url: string | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** True while a render runs. */
  rendering: boolean;
  /** A change came during the render, so another one is due after it. */
  again: boolean;
}

/**
 * Keeps a thumbnail for each open image. A change schedules one render, and changes within the
 * interval share it, so the work runs in the background at a bounded rate (UI-TABS-01). Changes during
 * a render share one more render after it, so a slow render never runs alongside another one.
 */
export class ThumbnailCache<T extends ThumbnailSource> {
  readonly #options: ThumbnailCacheOptions<T>;
  readonly #entries = new Map<string, Entry<T>>();

  constructor(options: ThumbnailCacheOptions<T>) {
    this.#options = options;
  }

  url(id: string): string | undefined {
    return this.#entries.get(id)?.url;
  }

  /** Tracks exactly `sources`: new ids start being watched, and ids that are gone stop. */
  sync(sources: ReadonlyMap<string, T>): void {
    for (const [id, entry] of this.#entries) {
      if (sources.get(id) !== entry.source) this.untrack(id);
    }
    for (const [id, source] of sources) {
      if (!this.#entries.has(id)) this.#track(id, source);
    }
  }

  untrack(id: string): void {
    const entry = this.#entries.get(id);
    if (entry === undefined) return;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.unsubscribe();
    this.#entries.delete(id);
  }

  dispose(): void {
    for (const id of [...this.#entries.keys()]) this.untrack(id);
  }

  #track(id: string, source: T): void {
    const entry: Entry<T> = {
      source,
      unsubscribe: () => {},
      url: undefined,
      timer: undefined,
      rendering: false,
      again: false,
    };
    this.#entries.set(id, entry);
    entry.unsubscribe = source.subscribe((change) => {
      // A selection preview changes nothing a tab shows.
      if (change === "selection") return;
      if (change !== "preview") this.#options.onChange();
      this.#schedule(id);
    });
    this.#schedule(id);
  }

  #schedule(id: string): void {
    const entry = this.#entries.get(id);
    if (entry === undefined || entry.timer !== undefined) return;
    if (entry.rendering) {
      entry.again = true;
      return;
    }
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (this.#options.busy?.() === true) this.#schedule(id);
      else void this.#render(id, entry);
    }, this.#options.intervalMs);
  }

  async #render(id: string, entry: Entry<T>): Promise<void> {
    if (this.#entries.get(id) !== entry) return;
    entry.rendering = true;
    let url: string | undefined;
    try {
      url = await this.#options.render(entry.source);
    } finally {
      entry.rendering = false;
    }
    if (this.#entries.get(id) !== entry) return;
    entry.url = url;
    this.#options.onChange();
    if (entry.again) {
      entry.again = false;
      this.#schedule(id);
    }
  }
}
