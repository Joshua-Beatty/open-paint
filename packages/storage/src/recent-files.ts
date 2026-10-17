/** FMT-OPEN-06 and WEB-FILE-04: up to ten recent files are listed. */
export const RECENT_FILES_CAPACITY = 10;

/** The database that holds the Open Recent list. */
export const DEFAULT_RECENT_FILES_DATABASE = "openpaint-recent";

const STORE = "recentFiles";

/** One Open Recent entry. The thumbnail is a PNG data URL, drawn at `thumbnailScale` times 64 px. */
export interface RecentFile {
  /** Grows with every entry, so the newest entry has the largest id. */
  readonly id: number;
  readonly name: string;
  /** The file handle, when the browser gave one. Without it, choosing the entry opens the picker. */
  readonly handle?: FileSystemFileHandle | undefined;
  readonly thumbnail?: string | undefined;
  readonly thumbnailScale?: number | undefined;
}

/** The fields of a new entry. The store assigns the id. */
export type NewRecentFile = Omit<RecentFile, "id">;

/** The records behind Open Recent. `replaceAll` writes the whole list in one step. */
export interface RecentFilesBackend {
  readAll(): Promise<readonly RecentFile[]>;
  replaceAll(entries: readonly RecentFile[]): Promise<void>;
}

/** The list held in memory. Used when storage is unavailable and in tests. */
export class MemoryRecentFilesBackend implements RecentFilesBackend {
  #entries: readonly RecentFile[] = [];

  async readAll(): Promise<readonly RecentFile[]> {
    return this.#entries;
  }

  async replaceAll(entries: readonly RecentFile[]): Promise<void> {
    this.#entries = [...entries];
  }
}

/** The list in an IndexedDB object store, one record per entry. File handles are stored as is. */
export class IndexedDbRecentFilesBackend implements RecentFilesBackend {
  readonly #databaseName: string;
  #database: Promise<IDBDatabase> | undefined;

  constructor(databaseName: string = DEFAULT_RECENT_FILES_DATABASE) {
    this.#databaseName = databaseName;
  }

  async readAll(): Promise<readonly RecentFile[]> {
    const database = await this.#open();
    return new Promise<readonly RecentFile[]>((resolve, reject) => {
      const transaction = database.transaction(STORE, "readonly");
      const request = transaction.objectStore(STORE).getAll();
      transaction.oncomplete = () => resolve(request.result as RecentFile[]);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("Recent read aborted."));
    });
  }

  async replaceAll(entries: readonly RecentFile[]): Promise<void> {
    const database = await this.#open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      store.clear();
      for (const entry of entries) store.put(entry, entry.id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("Recent write aborted."));
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

/**
 * Open Recent (FMT-OPEN-06). The newest entry comes first. Opening or saving a file with the same
 * name moves its entry to the front, and entries beyond the capacity are dropped. Changes stay in
 * memory for the session even when they cannot be written.
 */
export class RecentFiles {
  readonly #backend: RecentFilesBackend;
  readonly #listeners = new Set<() => void>();
  #entries: readonly RecentFile[];
  #persisted = true;
  #pending: Promise<void> = Promise.resolve();

  constructor(backend: RecentFilesBackend, entries: readonly RecentFile[] = []) {
    this.#backend = backend;
    this.#entries = newestFirst(entries);
  }

  /** Loads the stored entries. A store that cannot be read starts empty, unpersisted. */
  static async open(backend: RecentFilesBackend): Promise<RecentFiles> {
    try {
      return new RecentFiles(backend, await backend.readAll());
    } catch {
      const recent = new RecentFiles(backend);
      recent.#persisted = false;
      return recent;
    }
  }

  /** The entries, newest first. The array changes identity on every change. */
  get entries(): readonly RecentFile[] {
    return this.#entries;
  }

  get(id: number): RecentFile | undefined {
    return this.#entries.find((entry) => entry.id === id);
  }

  /** False after the last write failed. */
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

  /** Adds an entry as the newest one, replacing any entry with the same name. */
  add(file: NewRecentFile): RecentFile {
    const id = (this.#entries[0]?.id ?? 0) + 1;
    const next: RecentFile = { id, ...file };
    const rest = this.#entries.filter((entry) => entry.name !== file.name);
    this.#update([next, ...rest].slice(0, RECENT_FILES_CAPACITY));
    return next;
  }

  /** Removes one entry, such as a file that no longer exists. */
  remove(id: number): void {
    this.#update(this.#entries.filter((entry) => entry.id !== id));
  }

  /** Empties the list (FMT-OPEN-06 "Clear this list"). */
  clear(): void {
    this.#update([]);
  }

  #update(entries: readonly RecentFile[]): void {
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

function newestFirst(entries: readonly RecentFile[]): readonly RecentFile[] {
  return [...entries].sort((a, b) => b.id - a.id).slice(0, RECENT_FILES_CAPACITY);
}
