/** WEB-MEM-03 default budget: 2 GiB of pixel data per document. */
export const DEFAULT_MEMORY_BUDGET_BYTES = 2 * 1024 ** 3;

/** The operations that estimate their byte cost before they start (WEB-MEM-03). */
export type MemoryOperation = "newImage" | "paste" | "resize" | "canvasSize" | "import" | "move";

/** Raised before an allocation that would exceed the budget, or when the allocation itself fails. */
export class OutOfMemoryError extends Error {
  override readonly name = "OutOfMemoryError";

  constructor(
    readonly requestedBytes: number,
    readonly availableBytes: number,
    /** The operation whose pre-flight check refused, so its message can name it. */
    readonly operation?: MemoryOperation,
  ) {
    super(`Cannot allocate ${requestedBytes} bytes; ${availableBytes} bytes available.`);
  }
}

const GIGABYTE = 1024 ** 3;
const MIN_HEURISTIC_BUDGET_BYTES = 256 * 1024 ** 2;

/**
 * WEB-MEM-03: the per-document budget from `navigator.deviceMemory` (in GB, where the browser
 * reports it). A quarter of the device memory, kept between 256 MiB and the 2 GiB default. Without
 * a report the default applies.
 */
export function memoryBudgetForDeviceMemory(deviceMemoryGb: number | undefined): number {
  if (deviceMemoryGb === undefined || !(deviceMemoryGb > 0)) return DEFAULT_MEMORY_BUDGET_BYTES;
  const share = Math.floor((deviceMemoryGb * GIGABYTE) / 4);
  return Math.min(DEFAULT_MEMORY_BUDGET_BYTES, Math.max(MIN_HEURISTIC_BUDGET_BYTES, share));
}

/**
 * Tracks pixel bytes held against a budget. Callers reserve before allocating (ARC-05-07), so a
 * failed reservation leaves everything unchanged and the operation can be aborted (ARC-05-05).
 */
export class MemoryAccountant {
  #used = 0;

  constructor(readonly budgetBytes: number = DEFAULT_MEMORY_BUDGET_BYTES) {
    if (!(budgetBytes >= 0)) throw new RangeError("Memory budget must be non-negative.");
  }

  get usedBytes(): number {
    return this.#used;
  }

  get availableBytes(): number {
    return Math.max(0, this.budgetBytes - this.#used);
  }

  canReserve(bytes: number): boolean {
    return bytes <= this.availableBytes;
  }

  reserve(bytes: number): void {
    if (!(bytes >= 0)) throw new RangeError("Reservation must be non-negative.");
    if (!this.canReserve(bytes)) throw new OutOfMemoryError(bytes, this.availableBytes);
    this.#used += bytes;
  }

  release(bytes: number): void {
    if (!(bytes >= 0) || bytes > this.#used) {
      throw new RangeError("Released more bytes than were reserved.");
    }
    this.#used -= bytes;
  }
}

/** Reserves `bytes`, runs `allocate`, and releases the reservation if allocation throws. */
export function allocateWithBudget<T>(
  accountant: MemoryAccountant,
  bytes: number,
  allocate: () => T,
): T {
  accountant.reserve(bytes);
  try {
    return allocate();
  } catch (error) {
    accountant.release(bytes);
    if (error instanceof RangeError) throw new OutOfMemoryError(bytes, accountant.availableBytes);
    throw error;
  }
}
