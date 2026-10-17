/**
 * Slot bookkeeping for the GPU tile pool. Tiles live in a few texture
 * arrays ("pages"). A slot is one array layer of one page, encoded as `page << 16 | slice`. Pages
 * start small and double up to `maxSlices`, so a small image does not reserve a full page.
 */

/** A slot code that means "no tile": the tile is transparent and unallocated. */
export const NO_TILE = 0xffff_ffff;

export function slotCode(page: number, slice: number): number {
  return ((page << 16) | slice) >>> 0;
}

export function slotPage(code: number): number {
  return code >>> 16;
}

export function slotSlice(code: number): number {
  return code & 0xffff;
}

interface Page {
  /** Slices handed out so far, the high-water mark. Slices below it are used or free. */
  high: number;
  readonly free: number[];
  used: number;
  capacity: number;
}

export class TileAllocator {
  readonly #pages: Page[] = [];

  /**
   * `maxSlices` is the largest page (the device's array layer limit, at most 65536). Pages start
   * with `initialSlices` and double whenever a slice past the capacity is handed out.
   */
  constructor(
    readonly maxSlices: number,
    readonly initialSlices = 16,
  ) {
    if (maxSlices < 1 || maxSlices > 0x10000) throw new RangeError(`Bad page size ${maxSlices}.`);
  }

  get pageCount(): number {
    return this.#pages.length;
  }

  /** Slots in use over all pages. */
  get used(): number {
    return this.#pages.reduce((sum, page) => sum + page.used, 0);
  }

  /** Slices a page's texture must hold for the slots handed out so far. */
  capacity(page: number): number {
    return this.#pages[page]?.capacity ?? 0;
  }

  /**
   * Hands out a free slot, from `prefer` (a page) when it has room, so a layer's tiles tend to
   * share few pages. The page's capacity may grow; the caller checks `capacity` afterwards.
   */
  allocate(prefer?: number): number {
    const preferred = prefer === undefined ? undefined : this.#pages[prefer];
    if (preferred !== undefined && this.#hasRoom(preferred)) {
      return slotCode(prefer as number, this.#take(preferred));
    }
    for (const [index, page] of this.#pages.entries()) {
      if (this.#hasRoom(page)) return slotCode(index, this.#take(page));
    }
    const page: Page = {
      high: 0,
      free: [],
      used: 0,
      capacity: Math.min(this.initialSlices, this.maxSlices),
    };
    this.#pages.push(page);
    return slotCode(this.#pages.length - 1, this.#take(page));
  }

  free(code: number): void {
    const page = this.#pages[slotPage(code)];
    const slice = slotSlice(code);
    if (page === undefined || slice >= page.high)
      throw new RangeError(`Slot ${code} is not in use.`);
    page.free.push(slice);
    page.used -= 1;
  }

  /** Forgets every slot. Capacities are kept, since the textures still exist. */
  reset(): void {
    for (const page of this.#pages) {
      page.high = 0;
      page.free.length = 0;
      page.used = 0;
    }
  }

  #hasRoom(page: Page): boolean {
    return page.free.length > 0 || page.high < this.maxSlices;
  }

  #take(page: Page): number {
    page.used += 1;
    const reused = page.free.pop();
    if (reused !== undefined) return reused;
    const slice = page.high++;
    while (page.capacity <= slice) page.capacity = Math.min(this.maxSlices, page.capacity * 2);
    return slice;
  }
}
