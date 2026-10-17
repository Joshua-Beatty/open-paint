import type { Document, Layer } from "@openpaint/document";

export interface LayerThumbnailOptions {
  /**
   * Draws one layer's thumbnail as a data URL. It returns undefined when nothing can be drawn. It
   * may take several turns of the event loop (PRD-NF-02).
   */
  readonly render: (layer: Layer) => string | undefined | Promise<string | undefined>;
  /** Called after every renewal of the thumbnails. */
  readonly onChange: () => void;
  /** The shortest time between two renders of one document's layers, in milliseconds. */
  readonly intervalMs: number;
  /** True while the user drags on the canvas or an effect renders: renders wait until it ends (L8). */
  readonly busy?: () => boolean;
}

/**
 * The thumbnails of the layers of one document. Showing a document, or changing it, schedules one
 * render of every layer. Changes within the interval share that render, so the work runs at a
 * bounded rate (UI-FTW-05 live thumbnails, UI-TABS-01 throttling).
 */
export class LayerThumbnails {
  readonly #options: LayerThumbnailOptions;
  #doc: Document | undefined;
  #urls = new Map<number, string | undefined>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** The renders started, and the latest one whose thumbnails are shown. */
  #renders = 0;
  #shown = 0;

  constructor(options: LayerThumbnailOptions) {
    this.#options = options;
  }

  /** The thumbnail of the layer with `id`, or undefined until it is drawn. */
  url(id: number): string | undefined {
    return this.#urls.get(id);
  }

  /** Shows the layers of `doc`, which is the active image, or undefined when none is open. */
  show(doc: Document | undefined): void {
    if (doc !== this.#doc) {
      this.#doc = doc;
      this.#urls = new Map();
      this.#cancel();
      // A newly shown document has no thumbnails yet, so they are drawn at once rather than after
      // the interval; its layers' cached sums make that cheap (L4: no blank thumbnails for long).
      if (doc !== undefined) this.#schedule(0);
      return;
    }
    if (doc !== undefined) this.#schedule();
  }

  dispose(): void {
    this.#cancel();
    this.#doc = undefined;
    this.#urls = new Map();
  }

  #schedule(delayMs = this.#options.intervalMs): void {
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#options.busy?.() === true) this.#schedule();
      else void this.#renderAll();
    }, delayMs);
  }

  #cancel(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** Renders every layer of the shown document. A render that a newer one has passed is dropped. */
  async #renderAll(): Promise<void> {
    const doc = this.#doc;
    if (doc === undefined) return;
    this.#renders += 1;
    const render = this.#renders;
    const urls = new Map<number, string | undefined>();
    for (const layer of doc.layers) {
      urls.set(layer.id, await this.#options.render(layer));
      if (this.#doc !== doc) return;
    }
    if (render < this.#shown) return;
    this.#shown = render;
    this.#urls = urls;
    this.#options.onChange();
  }
}
