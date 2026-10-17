import { MemoryAccountant, memoryBudgetForDeviceMemory } from "@openpaint/document";

/**
 * The budget on a touch-first device that reports no device memory (iOS and iPadOS). Their tabs
 * are stopped well before 2 GiB of pixels, so the default would let an operation crash the tab.
 */
export const TOUCH_DEVICE_BUDGET_BYTES = 1024 ** 3;

/**
 * The per-document budget (WEB-MEM-03): a quarter of the device memory the browser reports, or
 * when it reports none, the 2 GiB default, or 1 GiB on a device whose primary pointer is coarse.
 */
export function documentBudgetBytes(deviceMemory: number | undefined, coarse: boolean): number {
  if (deviceMemory === undefined && coarse) return TOUCH_DEVICE_BUDGET_BYTES;
  return memoryBudgetForDeviceMemory(deviceMemory);
}

/** The budget for a new document (WEB-MEM-03). Each document gets its own budget. */
export function newDocumentAccountant(): MemoryAccountant {
  const { deviceMemory } = navigator as { deviceMemory?: number };
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  return new MemoryAccountant(documentBudgetBytes(deviceMemory, coarse));
}
