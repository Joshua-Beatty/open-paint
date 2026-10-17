import { BufferUsage } from "./gpu-device";

/** `GPUMapMode.READ`. */
const MAP_READ_MODE = 1;

interface Pooled {
  readonly buffer: GPUBuffer;
  readonly usage: number;
  busy: boolean;
}

/** The free and lent buffers of each device. */
const pools = new WeakMap<GPUDevice, Pooled[]>();

/** A buffer lent by `borrowBuffer`; `release` returns it for the next run. */
export interface BorrowedBuffer {
  readonly buffer: GPUBuffer;
  release(): void;
}

/**
 * Lends a buffer of at least `size` bytes with exactly `usage`, reused across effect runs on the
 * device instead of being created and destroyed per run (L9): the large outputs, planes and
 * readbacks of a preview are the same size every time. A buffer only grows: a larger request
 * replaces the largest free one. Runs that overlap get buffers of their own.
 */
export function borrowBuffer(
  device: GPUDevice,
  label: string,
  size: number,
  usage: number,
): BorrowedBuffer {
  let pool = pools.get(device);
  if (pool === undefined) {
    pool = [];
    pools.set(device, pool);
  }
  const bytes = Math.max(16, Math.ceil(size / 16) * 16);
  const free = pool.filter((entry) => !entry.busy && entry.usage === usage);
  let entry = free.find((candidate) => candidate.buffer.size >= bytes);
  if (entry === undefined) {
    const smaller = free.sort((a, b) => b.buffer.size - a.buffer.size)[0];
    if (smaller !== undefined) {
      smaller.buffer.destroy();
      pool.splice(pool.indexOf(smaller), 1);
    }
    entry = { buffer: device.createBuffer({ label, size: bytes, usage }), usage, busy: false };
    pool.push(entry);
  }
  entry.busy = true;
  const lent = entry;
  return {
    buffer: lent.buffer,
    release: () => {
      lent.busy = false;
    },
  };
}

/** Destroys a device's pooled buffers (a released device, tests). */
export function releasePool(device: GPUDevice): void {
  for (const entry of pools.get(device) ?? []) entry.buffer.destroy();
  pools.delete(device);
}

/**
 * Copies `bytes` of `source` into a pooled readback buffer with `encoder`, submits it, and resolves
 * with a copy of them: the one wait on the GPU of a run.
 */
export async function readBack(
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  source: GPUBuffer,
  bytes: number,
): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const readback = borrowBuffer(
    device,
    "readback",
    bytes,
    BufferUsage.MAP_READ | BufferUsage.COPY_DST,
  );
  try {
    encoder.copyBufferToBuffer(source, 0, readback.buffer, 0, bytes);
    device.queue.submit([encoder.finish()]);
    await readback.buffer.mapAsync(MAP_READ_MODE, 0, readback.buffer.size);
    const out = new Uint8ClampedArray(readback.buffer.getMappedRange(0, bytes).slice(0));
    readback.buffer.unmap();
    return out;
  } finally {
    readback.release();
  }
}
