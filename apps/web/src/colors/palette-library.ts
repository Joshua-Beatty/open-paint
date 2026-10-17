import {
  isNotFoundError,
  openOpfsDirectory,
  readOpfsFile,
  removeOpfsFile,
  writeOpfsFile,
} from "@openpaint/storage";
import type { Rgba } from "./color-math";
import {
  PALETTE_EXTENSION,
  paletteNameFromFileName,
  paletteNameProblem,
  parsePaletteText,
  serializePalette,
} from "./palette";

/**
 * Where user palettes are kept (DOC-COL-03, WEB-MEM-01): one `.txt` file per palette, named after
 * the palette. Built-in palettes are not stored here.
 */
export interface PaletteStorage {
  /** The names of the stored palettes. */
  list(): Promise<string[]>;
  /** The file text of a palette, or undefined when there is no palette with that name. */
  read(name: string): Promise<string | undefined>;
  write(name: string, text: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/**
 * Asks whether a palette with this name may be replaced (DOC-COL-04). Resolves true to replace
 * it, false to leave both palettes unchanged.
 */
export type ReplaceConfirmation = (name: string) => Promise<boolean>;

const NAME_ORDER = new Intl.Collator("en");

/** The user palette names, sorted by name. */
export async function paletteNames(storage: PaletteStorage): Promise<string[]> {
  return (await storage.list()).sort((left, right) => NAME_ORDER.compare(left, right));
}

/** A stored palette read as 96 colors, or undefined when it does not exist. */
export async function readPalette(
  storage: PaletteStorage,
  name: string,
): Promise<Rgba[] | undefined> {
  const text = await storage.read(name);
  return text === undefined ? undefined : parsePaletteText(text);
}

async function writePalette(
  storage: PaletteStorage,
  name: string,
  colors: readonly Rgba[],
): Promise<void> {
  await storage.write(name, serializePalette(colors));
}

/**
 * Saves the colors under a name. A name that is in use is replaced only when the user confirms.
 * Returns false when the name is invalid or the replacement was cancelled.
 */
export async function savePalette(
  storage: PaletteStorage,
  name: string,
  colors: readonly Rgba[],
  confirm: ReplaceConfirmation,
): Promise<boolean> {
  const target = name.trim();
  if (paletteNameProblem(target) !== null) return false;
  if ((await storage.list()).includes(target) && !(await confirm(target))) return false;
  await writePalette(storage, target, colors);
  return true;
}

/**
 * Renames a user palette. Returns false when the palette does not exist, the new name is invalid,
 * or the replacement of another palette was cancelled.
 */
export async function renamePalette(
  storage: PaletteStorage,
  from: string,
  to: string,
  confirm: ReplaceConfirmation,
): Promise<boolean> {
  const target = to.trim();
  if (target === from) return true;
  if (paletteNameProblem(target) !== null) return false;
  const text = await storage.read(from);
  if (text === undefined) return false;
  if ((await storage.list()).includes(target) && !(await confirm(target))) return false;
  await storage.write(target, text);
  await storage.remove(from);
  return true;
}

/** Deletes a user palette. Deleting a palette that does not exist does nothing. */
export async function deletePalette(storage: PaletteStorage, name: string): Promise<void> {
  await storage.remove(name);
}

export interface PaletteFile {
  /** The file name, with its extension. */
  readonly fileName: string;
  readonly text: string;
}

/**
 * Copies palette files into the user palettes (UI-FTW-06). Each file is named after its file name
 * without the extension, and a name in use asks first. Returns the names that were imported.
 */
export async function importPalettes(
  storage: PaletteStorage,
  files: readonly PaletteFile[],
  confirm: ReplaceConfirmation,
): Promise<string[]> {
  const imported: string[] = [];
  for (const file of files) {
    const name = paletteNameFromFileName(file.fileName);
    if (paletteNameProblem(name) !== null) continue;
    if ((await storage.list()).includes(name) && !(await confirm(name))) continue;
    await storage.write(name, serializePalette(parsePaletteText(file.text)));
    imported.push(name);
  }
  return imported;
}

/** Palettes in memory, for tests and for storage that is unavailable. */
export function memoryPaletteStorage(
  initial: Readonly<Record<string, string>> = {},
): PaletteStorage {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    async list() {
      return [...files.keys()];
    },
    async read(name) {
      return files.get(name);
    },
    async write(name, text) {
      files.set(name, text);
    },
    async remove(name) {
      files.delete(name);
    },
  };
}

/** Palettes in the origin's private file system (WEB-MEM-01, DOC-COL-03). */
export function opfsPaletteStorage(directoryName = "palettes"): PaletteStorage {
  let directory: Promise<FileSystemDirectoryHandle> | undefined;
  const open = () => {
    directory ??= openOpfsDirectory(directoryName);
    return directory;
  };
  const fileName = (name: string) => `${name}${PALETTE_EXTENSION}`;
  return {
    async list() {
      const names: string[] = [];
      for await (const [entry, handle] of (await open()).entries()) {
        if (handle.kind === "file" && entry.endsWith(PALETTE_EXTENSION)) {
          names.push(entry.slice(0, -PALETTE_EXTENSION.length));
        }
      }
      return names;
    },
    async read(name) {
      try {
        return new TextDecoder().decode(await readOpfsFile(await open(), fileName(name)));
      } catch (error) {
        if (isNotFoundError(error)) return undefined;
        throw error;
      }
    },
    async write(name, text) {
      await writeOpfsFile(await open(), fileName(name), new TextEncoder().encode(text));
    },
    async remove(name) {
      await removeOpfsFile(await open(), fileName(name));
    },
  };
}
