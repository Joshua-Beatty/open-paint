import { errorName } from "./file-errors";

/** A file the user chose to open, or one loaded again from a stored handle (WEB-FILE-01, WEB-FILE-04). */
export interface OpenedFile {
  readonly name: string;
  /** The handle, when the File System Access API gave one. Open Recent keeps it. */
  readonly handle?: FileSystemFileHandle | undefined;
  readonly bytes: () => Promise<Uint8Array<ArrayBuffer>>;
}

/** A file type as the pickers list it (FMT-OPEN-01): a label, MIME types and extensions. */
export interface PickerType {
  readonly description: string;
  readonly mimeTypes: readonly string[];
  readonly extensions: readonly string[];
}

/** The file a Save As picked. The handle is written to after encoding (WEB-FILE-03). */
export interface SaveTarget {
  readonly name: string;
  readonly handle: FileSystemFileHandle;
}

/**
 * The files the app reads and writes (WEB-FILE-01..03). The browser version uses the File System
 * Access API where it exists and falls back to an input and a download. Tests supply their own.
 */
export interface FileAccess {
  /** True when Save As can pick the file. Otherwise Save As asks for a name and downloads. */
  readonly canPickSaveTarget: boolean;
  /** Lets the user pick files to open. Resolves to nothing when the picker is canceled. */
  pickFiles(types: readonly PickerType[]): Promise<readonly OpenedFile[]>;
  /** Lets the user pick where to save. Resolves to nothing when the picker is canceled. */
  pickSaveTarget(
    suggestedName: string,
    types: readonly PickerType[],
  ): Promise<SaveTarget | undefined>;
  /** Reads a stored handle, asking again for read permission if needed (FMT-OPEN-06). */
  openHandle(handle: FileSystemFileHandle): Promise<OpenedFile>;
  /** Asks for write permission on a handle when it is not already granted (WEB-FILE-02). */
  ensureWritable(handle: FileSystemFileHandle): Promise<void>;
  /** Writes the bytes to the file. Nothing is written until `write` is called (FMT-SAVE-03). */
  write(handle: FileSystemFileHandle, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  /** Saves the bytes as a download under the name (the fallback of WEB-FILE-02). */
  download(name: string, mimeType: string, bytes: Uint8Array<ArrayBuffer>): void;
}

interface FileSystemPickers {
  showOpenFilePicker?: (options: Record<string, unknown>) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (options: Record<string, unknown>) => Promise<FileSystemFileHandle>;
}

interface PermissionedHandle {
  queryPermission?: (options: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (options: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
}

const OPEN_PICKER_ID = "openpaint-open";
const SAVE_PICKER_ID = "openpaint-save";
const DOWNLOAD_REVOKE_DELAY_MS = 10_000;

/** The file access of the browser (WEB-FILE-01, WEB-FILE-02). */
export function browserFileAccess(): FileAccess {
  const pickers = window as unknown as FileSystemPickers;
  const canPickSaveTarget =
    typeof pickers.showOpenFilePicker === "function" &&
    typeof pickers.showSaveFilePicker === "function";

  return {
    canPickSaveTarget,
    async pickFiles(types) {
      if (pickers.showOpenFilePicker === undefined) return pickWithInput(types);
      try {
        const handles = await pickers.showOpenFilePicker({
          multiple: true,
          id: OPEN_PICKER_ID,
          startIn: "pictures",
          excludeAcceptAllOption: true,
          types: types.map(toPickerOption),
        });
        return handles.map(fromHandle);
      } catch (error) {
        if (errorName(error) === "AbortError") return [];
        throw error;
      }
    },
    async pickSaveTarget(suggestedName, types) {
      if (pickers.showSaveFilePicker === undefined) return undefined;
      try {
        const handle = await pickers.showSaveFilePicker({
          suggestedName,
          id: SAVE_PICKER_ID,
          startIn: "pictures",
          excludeAcceptAllOption: true,
          types: types.map(toPickerOption),
        });
        return { name: handle.name, handle };
      } catch (error) {
        if (errorName(error) === "AbortError") return undefined;
        throw error;
      }
    },
    async openHandle(handle) {
      await ensurePermission(handle, "read");
      return fromHandle(handle);
    },
    ensureWritable: (handle) => ensurePermission(handle, "readwrite"),
    async write(handle, bytes) {
      const writable = await handle.createWritable();
      try {
        await writable.write(bytes);
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => undefined);
        throw error;
      }
    },
    download(name, mimeType, bytes) {
      const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_REVOKE_DELAY_MS);
    },
  };
}

function toPickerOption(type: PickerType): {
  description: string;
  accept: Record<string, string[]>;
} {
  const mimeTypes = type.mimeTypes.length > 0 ? type.mimeTypes : ["application/octet-stream"];
  return {
    description: type.description,
    accept: Object.fromEntries(mimeTypes.map((mime) => [mime, [...type.extensions]])),
  };
}

/** A file the user dropped or picked as a plain `File`, read when it is opened. */
export function openedFileOf(file: File): OpenedFile {
  return { name: file.name, bytes: () => readBytes(file) };
}

function fromHandle(handle: FileSystemFileHandle): OpenedFile {
  return { name: handle.name, handle, bytes: async () => readBytes(await handle.getFile()) };
}

async function readBytes(file: Blob): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await file.arrayBuffer());
}

/** The fallback for browsers without the File System Access API: a hidden file input. */
function pickWithInput(types: readonly PickerType[]): Promise<OpenedFile[]> {
  const accepted = types.some((type) => type.extensions.length === 0)
    ? undefined
    : [...new Set(types.flatMap((type) => type.extensions))].join(",");
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.hidden = true;
    if (accepted !== undefined) input.accept = accepted;
    const finish = (files: readonly File[]) => {
      input.remove();
      resolve(files.map((file) => ({ name: file.name, bytes: () => readBytes(file) })));
    };
    input.addEventListener("change", () => finish([...(input.files ?? [])]), { once: true });
    input.addEventListener("cancel", () => finish([]), { once: true });
    document.body.append(input);
    input.click();
  });
}

/** Checks a permission and asks for it when the browser has not granted it yet (WEB-FILE-02). */
async function ensurePermission(handle: FileSystemFileHandle, mode: "read" | "readwrite") {
  const permissioned = handle as FileSystemFileHandle & PermissionedHandle;
  if (permissioned.queryPermission === undefined) return;
  if ((await permissioned.queryPermission({ mode })) === "granted") return;
  if ((await permissioned.requestPermission?.({ mode })) === "granted") return;
  throw new DOMException("Access was denied to the file.", "NotAllowedError");
}
