/** The database that holds settings (SET-STO-01, SET-STO-04). */
export const DEFAULT_SETTINGS_DATABASE = "openpaint-settings";

const STORE = "settings";

/**
 * The records behind the settings store, one per setting path (SET-STO-01). `readAll` returns
 * every record, including keys this build does not know. `commit` applies a batch of writes and
 * deletes atomically.
 */
export interface SettingsBackend {
  readAll(): Promise<Map<string, unknown>>;
  commit(writes: ReadonlyMap<string, unknown>, deletes: ReadonlySet<string>): Promise<void>;
}

/** Settings held in memory. Used when storage is unavailable and in tests. */
export class MemorySettingsBackend implements SettingsBackend {
  readonly #records = new Map<string, unknown>();

  async readAll(): Promise<Map<string, unknown>> {
    return new Map(this.#records);
  }

  async commit(writes: ReadonlyMap<string, unknown>, deletes: ReadonlySet<string>): Promise<void> {
    for (const key of deletes) this.#records.delete(key);
    for (const [key, value] of writes) this.#records.set(key, value);
  }
}

/** Settings in the `settings` object store of IndexedDB (SET-STO-01). */
export class IndexedDbSettingsBackend implements SettingsBackend {
  readonly #databaseName: string;
  #database: Promise<IDBDatabase> | undefined;

  constructor(databaseName: string = DEFAULT_SETTINGS_DATABASE) {
    this.#databaseName = databaseName;
  }

  async readAll(): Promise<Map<string, unknown>> {
    const database = await this.#open();
    return new Promise<Map<string, unknown>>((resolve, reject) => {
      const transaction = database.transaction(STORE, "readonly");
      const store = transaction.objectStore(STORE);
      const keys = store.getAllKeys();
      const values = store.getAll();
      transaction.oncomplete = () => {
        const records = new Map<string, unknown>();
        keys.result.forEach((key, index) => {
          records.set(String(key), values.result[index]);
        });
        resolve(records);
      };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("Settings read aborted."));
    });
  }

  async commit(writes: ReadonlyMap<string, unknown>, deletes: ReadonlySet<string>): Promise<void> {
    const database = await this.#open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      for (const [key, value] of writes) store.put(value, key);
      for (const key of deletes) store.delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("Settings write aborted."));
    });
  }

  #open(): Promise<IDBDatabase> {
    this.#database ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB is not available."));
        return;
      }
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
}
