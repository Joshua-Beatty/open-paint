import type { SpillStorage } from "@openpaint/document";
import { openOpfsDirectory, readOpfsFile, removeOpfsFile, writeOpfsFile } from "./opfs";

/** The default OPFS folder for undo data (WEB-MEM-01). */
export const DEFAULT_SPILL_DIRECTORY = "openpaint-history";

/**
 * Undo data in the Origin Private File System (WEB-MEM-01). Each key is a file in one folder.
 * Writes go through `createWritable`, which replaces the file atomically when it closes.
 */
export class OpfsSpillStorage implements SpillStorage {
  readonly #directoryName: string;
  #directory: Promise<FileSystemDirectoryHandle> | undefined;

  constructor(directoryName: string = DEFAULT_SPILL_DIRECTORY) {
    this.#directoryName = directoryName;
  }

  async write(key: string, data: Uint8Array): Promise<void> {
    await writeOpfsFile(await this.#open(), key, data);
  }

  async read(key: string): Promise<Uint8Array> {
    return readOpfsFile(await this.#open(), key);
  }

  async remove(key: string): Promise<void> {
    await removeOpfsFile(await this.#open(), key);
  }

  #open(): Promise<FileSystemDirectoryHandle> {
    this.#directory ??= openOpfsDirectory(this.#directoryName);
    return this.#directory;
  }
}
