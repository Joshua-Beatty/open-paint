import { BufferUsage } from "../gpu-device";

/** Pixels of one tile slot: 256 × 256 packed RGBA8 words (or coverage words for a mask). */
export const SLOT_WORDS = 256 * 256;
export const SLOT_BYTES = SLOT_WORDS * 4;

/**
 * A storage buffer of tile-sized slots for the stroke being painted.
 * WebGPU has no read-write `rgba8unorm` storage textures, so stamping reads and writes packed
 * words here, and the result is copied into the tile pool. The buffer doubles when it runs out;
 * grow it (by allocating) before recording commands that use it.
 */
export class SlotBuffer {
  readonly #device: GPUDevice;
  #buffer: GPUBuffer;
  #capacity: number;
  #high = 0;
  readonly #free: number[] = [];

  constructor(device: GPUDevice, initial = 16) {
    this.#device = device;
    this.#capacity = initial;
    this.#buffer = this.#create(initial);
  }

  get buffer(): GPUBuffer {
    return this.#buffer;
  }

  get used(): number {
    return this.#high - this.#free.length;
  }

  offset(slot: number): number {
    return slot * SLOT_BYTES;
  }

  /** Word index of a slot's first pixel, as the shaders address it. */
  wordOffset(slot: number): number {
    return slot * SLOT_WORDS;
  }

  allocate(): number {
    const reused = this.#free.pop();
    if (reused !== undefined) return reused;
    if (this.#high >= this.#capacity) this.#grow(this.#capacity * 2);
    return this.#high++;
  }

  free(slot: number): void {
    this.#free.push(slot);
  }

  destroy(): void {
    this.#buffer.destroy();
  }

  #grow(capacity: number): void {
    const max = Math.floor(this.#device.limits.maxStorageBufferBindingSize / SLOT_BYTES);
    if (capacity > max) {
      if (this.#capacity >= max) throw new RangeError("The stroke covers too many tiles.");
      capacity = max;
    }
    const next = this.#create(capacity);
    const encoder = this.#device.createCommandEncoder({ label: "v2 slot buffer growth" });
    encoder.copyBufferToBuffer(this.#buffer, 0, next, 0, this.#capacity * SLOT_BYTES);
    this.#device.queue.submit([encoder.finish()]);
    this.#buffer.destroy();
    this.#buffer = next;
    this.#capacity = capacity;
  }

  #create(slots: number): GPUBuffer {
    return this.#device.createBuffer({
      label: "v2 stroke slots",
      size: slots * SLOT_BYTES,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC | BufferUsage.COPY_DST,
    });
  }
}
