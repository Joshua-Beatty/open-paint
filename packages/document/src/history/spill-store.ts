import { decodeSpill, encodeSpill, type SpillCodec } from "./chunks";

/**
 * Storage behind history spill (WEB-MEM-01): whole-blob writes keyed by name. The OPFS and
 * IndexedDB adapters in `@openpaint/storage` implement this interface.
 */
export interface SpillStorage {
  write(key: string, data: Uint8Array): Promise<void>;
  read(key: string): Promise<Uint8Array>;
  remove(key: string): Promise<void>;
}

/** The in-memory copy of spilled data may use at most this many bytes (ARC-05-02). */
export const DEFAULT_SPILL_CACHE_BYTES = 256 * 1024 * 1024;

/**
 * Runs the LZ4 work of a spill store. The app runs it in a worker, so a commit or a checkpoint does
 * not compress or decompress on the main thread (PRD-NF-02). The default runs in the calling thread.
 */
export interface SpillProcessor {
  /** May take over `raw`'s buffer, so the caller must not use `raw` afterwards. */
  encode(raw: Uint8Array, codec: SpillCodec): Promise<Uint8Array>;
  decode(encoded: Uint8Array): Promise<Uint8Array>;
}

const inlineProcessor: SpillProcessor = {
  async encode(raw, codec) {
    return encodeSpill(raw, codec);
  },
  async decode(encoded) {
    return decodeSpill(encoded);
  },
};

let defaultProcessor: SpillProcessor = inlineProcessor;

/** Sets the processor that stores without their own `processor` use from now on. */
export function setDefaultSpillProcessor(processor: SpillProcessor): void {
  defaultProcessor = processor;
}

/** An immutable reference to spilled data. Released handles cannot be read. */
export interface SpillHandle {
  readonly id: number;
  /** Size of the data before encoding, in bytes. */
  readonly rawBytes: number;
}

export interface SpillStoreOptions {
  readonly storage: SpillStorage;
  readonly codec?: SpillCodec;
  /** Encodes and decodes the data. Defaults to `setDefaultSpillProcessor`'s processor. */
  readonly processor?: SpillProcessor;
  readonly cacheBytes?: number;
  /** Key prefix, so several stores can share one storage. Random by default. */
  readonly namespace?: string;
}

/**
 * Write-once spill of history data (ARC-05-01/02). `put` keeps the raw data until it is encoded,
 * then keeps the encoded data in an LRU cache and writes it to storage in the background. Only
 * persisted entries are evicted, so a cache miss always reads from storage. Released handles are
 * deleted from storage.
 */
export class SpillStore {
  readonly #storage: SpillStorage;
  readonly #codec: SpillCodec;
  readonly #processor: SpillProcessor | undefined;
  readonly #cacheBytes: number;
  readonly #prefix: string;
  readonly #cache = new Map<number, Uint8Array>();
  readonly #encoding = new Map<number, Promise<Uint8Array>>();
  readonly #persisted = new Set<number>();
  readonly #pending = new Map<number, Promise<void>>();
  readonly #removals = new Set<Promise<void>>();
  readonly #live = new Set<number>();
  /** Pin counts of pinned handles, and the pinned handles released meanwhile. */
  readonly #pins = new Map<number, number>();
  readonly #released = new Set<number>();
  readonly #failures: unknown[] = [];
  #nextId = 1;
  #cachedBytes = 0;

  constructor(options: SpillStoreOptions) {
    this.#storage = options.storage;
    this.#codec = options.codec ?? "lz4";
    this.#processor = options.processor;
    this.#cacheBytes = options.cacheBytes ?? DEFAULT_SPILL_CACHE_BYTES;
    this.#prefix = `${options.namespace ?? `spill${Math.random().toString(36).slice(2, 10)}`}-`;
    if (!(this.#cacheBytes >= 0))
      throw new RangeError("The spill cache size must be non-negative.");
  }

  /** Bytes of encoded data held in memory. */
  get cachedBytes(): number {
    return this.#cachedBytes;
  }

  /** Handles that have been put and not yet released. */
  get liveCount(): number {
    return this.#live.size;
  }

  /**
   * Takes ownership of `data`: the caller must not use it afterwards. The data is encoded in the
   * background, and written once it is encoded.
   */
  put(data: Uint8Array): SpillHandle {
    const id = this.#nextId++;
    this.#live.add(id);
    const encoding = new Promise<Uint8Array>((resolve) => {
      resolve(this.#run().encode(data, this.#codec));
    });
    this.#encoding.set(id, encoding);
    const write = encoding
      .then((encoded) => {
        if (this.#live.has(id)) this.#remember(id, encoded);
        return this.#storage.write(this.#key(id), encoded);
      })
      .then(
        () => {
          this.#settle(id);
          if (this.#live.has(id)) this.#persisted.add(id);
          this.#evict();
        },
        (error: unknown) => {
          this.#settle(id);
          this.#failures.push(error);
        },
      );
    this.#pending.set(id, write);
    return { id, rawBytes: data.length };
  }

  /** Returns a fresh copy of the spilled data. Waits for the encode or reads from storage on a miss. */
  async get(handle: SpillHandle): Promise<Uint8Array> {
    if (!this.#live.has(handle.id)) throw new Error("The spilled data has been released.");
    const cached = this.#cache.get(handle.id);
    if (cached) {
      this.#cache.delete(handle.id);
      this.#cache.set(handle.id, cached);
      return this.#run().decode(cached);
    }
    const encoding = this.#encoding.get(handle.id);
    if (encoding !== undefined) return this.#run().decode(await encoding);
    const encoded = await this.#storage.read(this.#key(handle.id));
    if (this.#live.has(handle.id)) {
      this.#persisted.add(handle.id);
      this.#remember(handle.id, encoded);
      this.#evict();
    }
    return this.#run().decode(encoded);
  }

  /**
   * Keeps `handles` readable until the returned function is called, even if they are released
   * meanwhile: such a release takes effect at unpin. A session checkpoint pins the history data it
   * reads, so it does not have to block edits while it reads (WEB-MEM-05). Pins nest.
   */
  pin(handles: Iterable<SpillHandle>): () => void {
    const ids = [...new Set([...handles].map((handle) => handle.id))].filter((id) =>
      this.#live.has(id),
    );
    for (const id of ids) this.#pins.set(id, (this.#pins.get(id) ?? 0) + 1);
    let pinned = true;
    return () => {
      if (!pinned) return;
      pinned = false;
      for (const id of ids) {
        const count = (this.#pins.get(id) ?? 1) - 1;
        if (count > 0) {
          this.#pins.set(id, count);
          continue;
        }
        this.#pins.delete(id);
        if (this.#released.delete(id)) this.#free(id);
      }
    };
  }

  /**
   * Frees the handle's memory and deletes its storage once any pending write has finished. A pinned
   * handle is freed when its last pin ends.
   */
  release(handle: SpillHandle): void {
    if (!this.#live.has(handle.id)) return;
    if (this.#pins.has(handle.id)) {
      this.#released.add(handle.id);
      return;
    }
    this.#free(handle.id);
  }

  #free(id: number): void {
    if (!this.#live.delete(id)) return;
    const cached = this.#cache.get(id);
    if (cached) {
      this.#cache.delete(id);
      this.#cachedBytes -= cached.length;
    }
    this.#persisted.delete(id);
    const key = this.#key(id);
    const removal = (this.#pending.get(id) ?? Promise.resolve()).then(() =>
      this.#storage.remove(key).catch((error: unknown) => {
        this.#failures.push(error);
      }),
    );
    this.#removals.add(removal);
    void removal.then(() => {
      this.#removals.delete(removal);
    });
  }

  /** Resolves once every write and deletion has finished. Rejects with the first failure. */
  async flush(): Promise<void> {
    while (this.#pending.size > 0 || this.#removals.size > 0) {
      await Promise.all([...this.#pending.values(), ...this.#removals]);
    }
    const failure = this.#failures.shift();
    if (failure !== undefined) {
      this.#failures.length = 0;
      throw failure;
    }
  }

  #run(): SpillProcessor {
    return this.#processor ?? defaultProcessor;
  }

  #key(id: number): string {
    return `${this.#prefix}${id}`;
  }

  /** Forgets an encode or write that has finished, or failed. */
  #settle(id: number): void {
    this.#pending.delete(id);
    this.#encoding.delete(id);
  }

  #remember(id: number, encoded: Uint8Array): void {
    const previous = this.#cache.get(id);
    if (previous) this.#cachedBytes -= previous.length;
    this.#cache.set(id, encoded);
    this.#cachedBytes += encoded.length;
  }

  #evict(): void {
    for (const [id, encoded] of this.#cache) {
      if (this.#cachedBytes <= this.#cacheBytes) break;
      if (!this.#persisted.has(id)) continue;
      this.#cache.delete(id);
      this.#cachedBytes -= encoded.length;
    }
  }
}
