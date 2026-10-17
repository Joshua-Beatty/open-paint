import type { SpillStorage } from "@openpaint/document";

/** The default IndexedDB database for undo data when OPFS is unavailable (WEB-MEM-01). */
export const DEFAULT_SPILL_DATABASE = "openpaint-history";

const STORE = "spill";

/**
 * Undo data in IndexedDB, the fallback when OPFS is unavailable (WEB-MEM-01). Each key is a
 * record in one object store. A write resolves only after its transaction has committed.
 */
export class IndexedDbSpillStorage implements SpillStorage {
  readonly #databaseName: string;
  #database: Promise<IDBDatabase> | undefined;

  constructor(databaseName: string = DEFAULT_SPILL_DATABASE) {
    this.#databaseName = databaseName;
  }

  async write(key: string, data: Uint8Array): Promise<void> {
    await this.#transact("readwrite", (store) => store.put(data, key));
  }

  async read(key: string): Promise<Uint8Array> {
    const data = await this.#transact<Uint8Array | undefined>("readonly", (store) =>
      store.get(key),
    );
    if (!data) throw new Error(`No spilled data is stored under ${key}.`);
    return data;
  }

  async remove(key: string): Promise<void> {
    await this.#transact("readwrite", (store) => store.delete(key));
  }

  #open(): Promise<IDBDatabase> {
    this.#database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.#databaseName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        this.#database = undefined;
        reject(request.error);
      };
    });
    return this.#database;
  }

  async #transact<T>(
    mode: IDBTransactionMode,
    act: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const database = await this.#open();
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      const request = act(transaction.objectStore(STORE));
      let result: T | undefined;
      request.onsuccess = () => {
        result = request.result;
      };
      transaction.oncomplete = () => {
        resolve(result as T);
      };
      transaction.onerror = () => {
        reject(transaction.error);
      };
      transaction.onabort = () => {
        reject(transaction.error ?? new Error("The undo data transaction was aborted."));
      };
    });
  }
}
