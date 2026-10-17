/** The rectangle a Zoom tool drag is drawing, in image pixels (TL-ZOOM-01). */
export interface ZoomRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The outline of a rectangle zoom in progress, read by the canvas overlay through `useSyncExternalStore`. */
class ZoomRectangleStore {
  #state: ZoomRectangle | undefined;
  readonly #listeners = new Set<() => void>();

  get state(): ZoomRectangle | undefined {
    return this.#state;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  set(state: ZoomRectangle | undefined): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

export const zoomRectangle = new ZoomRectangleStore();
