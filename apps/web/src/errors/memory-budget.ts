import { MemoryAccountant, memoryBudgetForDeviceMemory } from "@openpaint/document";

/**
 * The budget for a new document (WEB-MEM-03): a quarter of the device memory the browser reports,
 * or the 2 GiB default when it reports none. Each document gets its own budget.
 */
export function newDocumentAccountant(): MemoryAccountant {
  const { deviceMemory } = navigator as { deviceMemory?: number };
  return new MemoryAccountant(memoryBudgetForDeviceMemory(deviceMemory));
}
