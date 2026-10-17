import type { FileCodec, FileDocument, FileTypeDescriptor } from "@openpaint/extension-api";
import type { PropertyValues } from "@openpaint/properties";
import type { PrintMode } from "../print/print-job";

/** What the user answered to a failed transfer (FMT-OPEN-03). */
export type TransferChoice = "retry" | "skip" | "cancel";

/**
 * The Save Configuration answer (FMT-UI-01). `encoded` holds the bytes of the final preview when
 * they were made from `values`, so the write can reuse them (FMT-UI-03).
 */
export interface SaveConfigChoice {
  readonly values: PropertyValues;
  readonly encoded: Uint8Array<ArrayBuffer> | undefined;
}

/** What the Save Configuration dialog needs to build its options and its preview. */
export interface SaveConfigRequest {
  readonly type: FileTypeDescriptor;
  readonly codec: FileCodec;
  /** The flattened image the preview encodes. */
  readonly file: FileDocument;
  /** The starting values: the remembered last-used values (FMT-UI-01). */
  readonly values: PropertyValues;
}

/** What the user chose for dropped files (UI-DOC-02): open each one, or add them as layers. */
export type DropChoice = "open" | "addLayers";

/** The answer to an imported image that is larger than the canvas (DOC-LYR-05e, DOC-CLP-05). */
export type CanvasFitChoice = "expand" | "keep" | "cancel";

/** A type in the download Save As dialog's Type list. */
export interface SaveTypeChoice {
  readonly id: string;
  readonly label: string;
}

/** The name and type the user chose in the download Save As dialog. */
export interface SaveNameChoice {
  readonly name: string;
  readonly typeId: string;
}

/** The one file dialog that is on screen, with the callbacks that answer it. */
export type FileDialogRequest =
  | { readonly kind: "flatten"; readonly answer: (flatten: boolean) => void }
  | { readonly kind: "recoverLayers"; readonly answer: (open: boolean) => void }
  | {
      readonly kind: "dropChoice";
      readonly count: number;
      readonly hasImage: boolean;
      readonly answer: (choice: DropChoice | undefined) => void;
    }
  | { readonly kind: "importSize"; readonly answer: (choice: CanvasFitChoice) => void }
  | {
      readonly kind: "saveName";
      readonly name: string;
      readonly types: readonly SaveTypeChoice[];
      readonly typeId: string;
      readonly answer: (choice: SaveNameChoice | undefined) => void;
    }
  | { readonly kind: "saving" }
  | { readonly kind: "print"; readonly answer: (mode: PrintMode | undefined) => void }
  | (SaveConfigRequest & {
      readonly kind: "saveConfig";
      readonly answer: (choice: SaveConfigChoice | undefined) => void;
    })
  | {
      readonly kind: "transfer";
      /** The 1-based position of the file being transferred. */
      readonly index: number;
      readonly total: number;
      readonly canceling: boolean;
      readonly cancel: () => void;
    }
  | {
      readonly kind: "transferError";
      readonly message: string;
      readonly answer: (choice: TransferChoice) => void;
    };

/**
 * The file dialogs as state. Flows show one request at a time and await the answer, and the host
 * component draws whichever request is current (the save flow prompts, the transfer progress).
 */
export class FileDialogs {
  #request: FileDialogRequest | undefined;
  readonly #listeners = new Set<() => void>();

  get request(): FileDialogRequest | undefined {
    return this.#request;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  show(request: FileDialogRequest): void {
    this.#set(request);
  }

  close(): void {
    this.#set(undefined);
  }

  /** FMT-SAVE-02: resolves to whether the user chose Flatten. */
  flatten(): Promise<boolean> {
    return new Promise((resolve) => {
      this.show({
        kind: "flatten",
        answer: (flatten) => {
          this.close();
          resolve(flatten);
        },
      });
    });
  }

  /**
   * FMT-NAT-09: a layered file had layers that could not be read. Resolves to whether the user chose
   * Open, which loads those layers blank, or Cancel.
   */
  recoverLayers(): Promise<boolean> {
    return new Promise((resolve) => {
      this.show({
        kind: "recoverLayers",
        answer: (open) => {
          this.close();
          resolve(open);
        },
      });
    });
  }

  /**
   * UI-DOC-02: the "Drag and Drop" question. Resolves to nothing when canceled. With no image open,
   * "Add layers" creates a new image first.
   */
  dropChoice(count: number, hasImage: boolean): Promise<DropChoice | undefined> {
    return new Promise((resolve) => {
      this.show({
        kind: "dropChoice",
        count,
        hasImage,
        answer: (choice) => {
          this.close();
          resolve(choice);
        },
      });
    });
  }

  /** DOC-LYR-05e: asks whether an imported image larger than the canvas expands the canvas. */
  importSize(): Promise<CanvasFitChoice> {
    return new Promise((resolve) => {
      this.show({
        kind: "importSize",
        answer: (choice) => {
          this.close();
          resolve(choice);
        },
      });
    });
  }

  /** The download Save As dialog (FMT-SAVE-01). Resolves to nothing when canceled. */
  saveName(
    name: string,
    types: readonly SaveTypeChoice[],
    typeId: string,
  ): Promise<SaveNameChoice | undefined> {
    return new Promise((resolve) => {
      this.show({
        kind: "saveName",
        name,
        types,
        typeId,
        answer: (choice) => {
          this.close();
          resolve(choice);
        },
      });
    });
  }

  /** File > Print (FMT-PRN-01). Resolves to the chosen size, or nothing when canceled. */
  printChoice(): Promise<PrintMode | undefined> {
    return new Promise((resolve) => {
      this.show({
        kind: "print",
        answer: (mode) => {
          this.close();
          resolve(mode);
        },
      });
    });
  }

  /** The Save Configuration dialog (FMT-UI-01). Resolves to nothing when canceled. */
  configureSave(request: SaveConfigRequest): Promise<SaveConfigChoice | undefined> {
    return new Promise((resolve) => {
      this.show({
        ...request,
        kind: "saveConfig",
        answer: (choice) => {
          this.close();
          resolve(choice);
        },
      });
    });
  }

  /** FMT-OPEN-03: resolves to what the user chose after a failed transfer. */
  transferError(message: string): Promise<TransferChoice> {
    return new Promise((resolve) => {
      this.show({
        kind: "transferError",
        message,
        answer: (choice) => {
          this.close();
          resolve(choice);
        },
      });
    });
  }

  #set(request: FileDialogRequest | undefined): void {
    this.#request = request;
    for (const listener of this.#listeners) listener();
  }
}
