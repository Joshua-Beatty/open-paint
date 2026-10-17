import {
  isNotFoundError,
  openOpfsDirectory,
  readOpfsFile,
  removeOpfsFile,
  writeOpfsFile,
} from "./opfs";

/** The OPFS folder for session checkpoints (WEB-MEM-05). */
export const DEFAULT_SESSION_DIRECTORY = "openpaint-session";

/** The lock name prefix that marks an owner's instance as alive (SET-LIFE-02). */
const OWNER_LOCK_PREFIX = "openpaint-session-owner:";
const MANIFEST_FILE = "manifest.json";
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A checkpoint: a JSON document plus the binary blobs it names. */
export interface SessionCheckpoint {
  readonly document: unknown;
  readonly blobs: ReadonlyMap<string, Uint8Array>;
  /**
   * Blobs of the same owner and key's last write to keep without writing them again. The caller
   * names blobs by their content, so a kept blob still holds what the name stands for (L2, L9).
   */
  readonly retained?: readonly string[];
}

/** One stored checkpoint: the owner instance that wrote it, and its key within that owner. */
export interface SessionEntry {
  readonly owner: string;
  readonly key: string;
}

/**
 * Checkpoints of open documents, one folder per owner instance and key (WEB-MEM-05, SET-LIFE-02).
 * A write replaces a checkpoint atomically: the new blobs are written first, then the manifest that
 * names them and the retained ones, and the files no manifest names any more are removed last.
 */
export interface SessionStore {
  write(owner: string, key: string, checkpoint: SessionCheckpoint): Promise<void>;
  read(owner: string, key: string): Promise<SessionCheckpoint>;
  remove(owner: string, key: string): Promise<void>;
  list(): Promise<SessionEntry[]>;
}

interface StoredManifest {
  /**
   * The file name prefix of the blobs: a generation token for checkpoints written before blobs were
   * kept across writes, or empty for `blob.<name>` files.
   */
  readonly generation: string;
  readonly blobs: readonly string[];
  readonly document: unknown;
}

/** The file that holds blob `name` of a manifest. */
function blobFile(manifest: Pick<StoredManifest, "generation">, name: string): string {
  return manifest.generation === "" ? `${BLOB_PREFIX}${name}` : `${manifest.generation}.${name}`;
}

const BLOB_PREFIX = "blob.";

/** Session checkpoints in the Origin Private File System (WEB-MEM-05). */
export class OpfsSessionStore implements SessionStore {
  readonly #root: () => Promise<FileSystemDirectoryHandle>;
  #rootDirectory: Promise<FileSystemDirectoryHandle> | undefined;

  constructor(
    root: () => Promise<FileSystemDirectoryHandle> = () =>
      openOpfsDirectory(DEFAULT_SESSION_DIRECTORY),
  ) {
    this.#root = root;
  }

  async write(owner: string, key: string, checkpoint: SessionCheckpoint): Promise<void> {
    const directory = await this.#entryDirectory(owner, key, true);
    const manifest: StoredManifest = {
      generation: "",
      blobs: [...new Set([...checkpoint.blobs.keys(), ...(checkpoint.retained ?? [])])],
      document: checkpoint.document,
    };
    for (const [name, data] of checkpoint.blobs) {
      await writeOpfsFile(directory, blobFile(manifest, name), data);
    }
    await writeOpfsFile(
      directory,
      MANIFEST_FILE,
      new TextEncoder().encode(JSON.stringify(manifest)),
    );
    const used = new Set(manifest.blobs.map((name) => blobFile(manifest, name)));
    const stale: string[] = [];
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind === "file" && name !== MANIFEST_FILE && !used.has(name)) stale.push(name);
    }
    for (const name of stale) await removeOpfsFile(directory, name);
  }

  async read(owner: string, key: string): Promise<SessionCheckpoint> {
    const directory = await this.#entryDirectory(owner, key, false);
    const manifest = parseManifest(await readOpfsFile(directory, MANIFEST_FILE));
    const blobs = new Map<string, Uint8Array>();
    for (const name of manifest.blobs) {
      blobs.set(name, await readOpfsFile(directory, blobFile(manifest, name)));
    }
    return { document: manifest.document, blobs };
  }

  async remove(owner: string, key: string): Promise<void> {
    const root = await this.#rootHandle();
    let ownerDirectory: FileSystemDirectoryHandle;
    try {
      ownerDirectory = await root.getDirectoryHandle(checkId(owner));
    } catch (error) {
      if (isNotFoundError(error)) return;
      throw error;
    }
    try {
      await ownerDirectory.removeEntry(checkId(key), { recursive: true });
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }

  async list(): Promise<SessionEntry[]> {
    const entries: SessionEntry[] = [];
    const root = await this.#rootHandle();
    for await (const [owner, ownerHandle] of root.entries()) {
      if (ownerHandle.kind !== "directory") continue;
      for await (const [key, keyHandle] of (ownerHandle as FileSystemDirectoryHandle).entries()) {
        if (keyHandle.kind === "directory") entries.push({ owner, key });
      }
    }
    return entries;
  }

  async #entryDirectory(
    owner: string,
    key: string,
    create: boolean,
  ): Promise<FileSystemDirectoryHandle> {
    const root = await this.#rootHandle();
    const ownerDirectory = await root.getDirectoryHandle(checkId(owner), { create });
    return ownerDirectory.getDirectoryHandle(checkId(key), { create });
  }

  #rootHandle(): Promise<FileSystemDirectoryHandle> {
    this.#rootDirectory ??= this.#root();
    return this.#rootDirectory;
  }
}

/** The session store of this browser, or undefined when the origin has no OPFS. */
export function openSessionStore(): SessionStore | undefined {
  if (typeof navigator?.storage?.getDirectory !== "function") return undefined;
  return new OpfsSessionStore();
}

/**
 * This tab's owner id. It is kept in sessionStorage, so a reload of the same tab keeps its
 * checkpoints, and a new tab gets its own (SET-LIFE-02).
 */
export function sessionOwnerId(): string {
  const key = "openpaint.session-owner";
  try {
    const stored = sessionStorage.getItem(key);
    if (stored !== null && ID_PATTERN.test(stored)) return stored;
    const id = randomToken(12);
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    return randomToken(12);
  }
}

/**
 * Holds the lock that marks `owner`'s instance as alive. The lock is released when the page closes,
 * so checkpoints of a closed instance are no longer live (SET-LIFE-02).
 */
export function holdOwnerLock(owner: string): void {
  const locks = globalThis.navigator?.locks;
  if (locks === undefined) return;
  void locks.request(`${OWNER_LOCK_PREFIX}${owner}`, () => new Promise<void>(() => {}));
}

/**
 * The owners whose instances are alive. Without the Web Locks API no owner can be shown to be gone,
 * so every owner counts as alive and nothing from another instance is offered for restore.
 */
export async function liveSessionOwners(): Promise<ReadonlySet<string> | "all"> {
  const locks = globalThis.navigator?.locks;
  if (locks === undefined) return "all";
  const snapshot = await locks.query();
  const owners = new Set<string>();
  for (const lock of snapshot.held ?? []) {
    if (lock.name?.startsWith(OWNER_LOCK_PREFIX)) {
      owners.add(lock.name.slice(OWNER_LOCK_PREFIX.length));
    }
  }
  return owners;
}

/** Asks the browser to keep this origin's storage (WEB-MEM-02). Resolves to whether it is persistent. */
export async function requestPersistentStorage(): Promise<boolean> {
  const storage = globalThis.navigator?.storage;
  if (typeof storage?.persist !== "function") return false;
  try {
    return await storage.persist();
  } catch {
    return false;
  }
}

function parseManifest(bytes: Uint8Array): StoredManifest {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as StoredManifest).generation !== "string" ||
    !Array.isArray((parsed as StoredManifest).blobs) ||
    !("document" in parsed)
  ) {
    throw new Error("The session checkpoint is damaged.");
  }
  return parsed as StoredManifest;
}

function checkId(id: string): string {
  if (!ID_PATTERN.test(id)) throw new RangeError(`Invalid session id ${id}.`);
  return id;
}

function randomToken(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => (byte % 36).toString(36)).join("");
}
