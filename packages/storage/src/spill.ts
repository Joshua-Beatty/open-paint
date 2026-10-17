import type { SpillStorage } from "@openpaint/document";
import { IndexedDbSpillStorage } from "./spill-indexeddb";
import { OpfsSpillStorage } from "./spill-opfs";

/**
 * The best undo-data storage the browser offers (WEB-MEM-01): OPFS, else IndexedDB. Throws when
 * neither exists, so the caller can tell the user that undo cannot spill.
 */
export function createSpillStorage(): SpillStorage {
  if (typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function") {
    return new OpfsSpillStorage();
  }
  if (typeof indexedDB !== "undefined") return new IndexedDbSpillStorage();
  throw new Error("Neither OPFS nor IndexedDB is available for undo data.");
}
