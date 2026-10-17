/** SET-ERR-01: the newest entry plus the 19 most recent older entries are kept. */
export const ERROR_LOG_CAPACITY = 20;

/** The database that holds the local error log (SET-STO-04). */
export const DEFAULT_ERROR_LOG_DATABASE = "openpaint-diagnostics";

const STORE = "errorLog";

/** One entry of the local error log (SET-ERR-01). `text` is the full copyable body. */
export interface ErrorLogEntry {
  /** Grows with every entry, so the newest entry has the largest id. */
  readonly id: number;
  /** When the error happened, as an ISO 8601 string in UTC. */
  readonly time: string;
  /** The error message, shown in the list. */
  readonly title: string;
  /** The entry as the user copies it: the SET-ERR-01 header, body and separator line. */
  readonly text: string;
}

/** The records behind the error log. `replaceAll` writes the whole list in one step. */
export interface ErrorLogBackend {
  readAll(): Promise<readonly ErrorLogEntry[]>;
  replaceAll(entries: readonly ErrorLogEntry[]): Promise<void>;
}

/** The error log held in memory. Used when storage is unavailable and in tests. */
export class MemoryErrorLogBackend implements ErrorLogBackend {
  #entries: readonly ErrorLogEntry[] = [];

  async readAll(): Promise<readonly ErrorLogEntry[]> {
    return this.#entries;
  }

  async replaceAll(entries: readonly ErrorLogEntry[]): Promise<void> {
    this.#entries = [...entries];
  }
}

/** The error log in an IndexedDB object store, one record per entry (SET-ERR-01). */
export class IndexedDbErrorLogBackend implements ErrorLogBackend {
  readonly #databaseName: string;
  #database: Promise<IDBDatabase> | undefined;

  constructor(databaseName: string = DEFAULT_ERROR_LOG_DATABASE) {
    this.#databaseName = databaseName;
  }

  async readAll(): Promise<readonly ErrorLogEntry[]> {
    const database = await this.#open();
    return new Promise<readonly ErrorLogEntry[]>((resolve, reject) => {
      const transaction = database.transaction(STORE, "readonly");
      const request = transaction.objectStore(STORE).getAll();
      transaction.oncomplete = () => resolve(request.result as ErrorLogEntry[]);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("Error log read aborted."));
    });
  }

  async replaceAll(entries: readonly ErrorLogEntry[]): Promise<void> {
    const database = await this.#open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      store.clear();
      for (const entry of entries) store.put(entry, entry.id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Error log write aborted."));
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

/** The fields of a new entry. The store assigns the id. */
export interface NewErrorLogEntry {
  readonly time: string;
  readonly title: string;
  readonly text: string;
}

/**
 * The local error log (SET-ERR-01, WEB-SEC-03). Entries are never sent anywhere. The newest entry
 * is kept with the 19 most recent older ones, and the rest are deleted. Entries are kept in memory
 * for the session even when they cannot be written, so the error dialog can still show them.
 */
export class ErrorLog {
  readonly #backend: ErrorLogBackend;
  readonly #listeners = new Set<() => void>();
  #entries: readonly ErrorLogEntry[];
  #persisted = true;
  #pending: Promise<void> = Promise.resolve();

  constructor(backend: ErrorLogBackend, entries: readonly ErrorLogEntry[] = []) {
    this.#backend = backend;
    this.#entries = newestFirst(entries);
  }

  /** Loads the stored entries. A store that cannot be read starts empty, with the log unpersisted. */
  static async open(backend: ErrorLogBackend): Promise<ErrorLog> {
    try {
      return new ErrorLog(backend, await backend.readAll());
    } catch {
      const log = new ErrorLog(backend);
      log.#persisted = false;
      return log;
    }
  }

  /** The entries, newest first. The array changes identity on every change. */
  get entries(): readonly ErrorLogEntry[] {
    return this.#entries;
  }

  /** False after the last write failed. Entries then live only in memory for this session. */
  get persisted(): boolean {
    return this.#persisted;
  }

  /** Resolves once every write started so far has finished. */
  settled(): Promise<void> {
    return this.#pending;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Adds an entry as the newest one and drops the entries beyond the capacity. */
  record(entry: NewErrorLogEntry): ErrorLogEntry {
    const id = (this.#entries[0]?.id ?? 0) + 1;
    const next: ErrorLogEntry = { id, ...entry };
    this.#update([next, ...this.#entries].slice(0, ERROR_LOG_CAPACITY));
    return next;
  }

  /** Deletes every entry (SET-DLG-12 "Clear error log"). */
  clear(): void {
    this.#update([]);
  }

  #update(entries: readonly ErrorLogEntry[]): void {
    this.#entries = entries;
    this.#pending = this.#pending
      .then(() => this.#backend.replaceAll(entries))
      .then(
        () => {
          this.#persisted = true;
        },
        () => {
          this.#persisted = false;
        },
      );
    for (const listener of this.#listeners) listener();
  }
}

function newestFirst(entries: readonly ErrorLogEntry[]): readonly ErrorLogEntry[] {
  return [...entries].sort((a, b) => b.id - a.id).slice(0, ERROR_LOG_CAPACITY);
}
