/**
 * Origin Private File System helpers shared by the storage adapters (WEB-MEM-01, SET-STO-04).
 * Every function takes the directory it works in, so tests can pass an in-memory tree.
 */

/** Opens (creating when needed) a named folder at the root of the origin's private file system. */
export async function openOpfsDirectory(name: string): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(name, { create: true });
}

/**
 * Writes a file through `createWritable`, which replaces the file atomically when it closes. A
 * failed write is aborted, so the previous contents stay in place.
 */
export async function writeOpfsFile(
  directory: FileSystemDirectoryHandle,
  name: string,
  data: Uint8Array,
): Promise<void> {
  const file = await directory.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  try {
    await writable.write(data as Uint8Array<ArrayBuffer>);
  } catch (error) {
    await writable.abort();
    throw error;
  }
  await writable.close();
}

/** Reads a whole file. Rejects with a `NotFoundError` when the file does not exist. */
export async function readOpfsFile(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<Uint8Array> {
  const file = await (await directory.getFileHandle(name)).getFile();
  return new Uint8Array(await file.arrayBuffer());
}

/** Removes a file. Removing a file that does not exist does nothing. */
export async function removeOpfsFile(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  try {
    await directory.removeEntry(name);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
}

export function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}
