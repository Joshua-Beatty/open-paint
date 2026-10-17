import type { SpillStorage } from "./spill-store";

/** A volatile `SpillStorage` for tests and for documents that need no session recovery. */
export class MemorySpillStorage implements SpillStorage {
  readonly #blobs = new Map<string, Uint8Array>();

  /** Number of blobs currently stored. */
  get size(): number {
    return this.#blobs.size;
  }

  async write(key: string, data: Uint8Array): Promise<void> {
    this.#blobs.set(key, data.slice());
  }

  async read(key: string): Promise<Uint8Array> {
    const blob = this.#blobs.get(key);
    if (!blob) throw new Error(`No spilled data is stored under ${key}.`);
    return blob.slice();
  }

  async remove(key: string): Promise<void> {
    this.#blobs.delete(key);
  }
}
