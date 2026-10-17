import { type BundledFamily, DEFAULT_FONT_FAMILY } from "./bundled-fonts";
import { resolveFamily } from "./text-options";

/** Where a font family comes from (WEB-FONT-01). */
export type FontSource = "bundled" | "uploaded" | "local";

export interface FontEntry {
  readonly family: string;
  readonly source: FontSource;
}

/** The face a text is drawn in, as the catalog loads it. */
export interface FontRequest {
  readonly family: string;
  readonly bold: boolean;
  readonly italic: boolean;
}

/** The CSS font of a request, as the font set matches it. The size does not change the match. */
export function cssFontOf(face: FontRequest): string {
  const style = face.italic ? "italic " : "";
  const weight = face.bold ? "bold " : "";
  return `${style}${weight}16px "${face.family.replaceAll('"', "")}"`;
}

/** The state of the installed-fonts list: not offered, not asked for yet, loading, or loaded. */
export type LocalFontState = "unavailable" | "idle" | "loading" | "ready" | "denied";

export interface FontCatalogState {
  readonly families: readonly FontEntry[];
  readonly local: LocalFontState;
}

/**
 * One face to make available to the canvas. `data` is a file URL, fetched only when the face is
 * first used, or the file's bytes, which load at once.
 */
export interface FontFaceRegistration {
  readonly family: string;
  /** A weight, or the range of a variable face. */
  readonly weight: number | readonly [number, number];
  readonly style: "normal" | "italic";
  readonly data: string | Uint8Array;
  readonly unicodeRange?: string;
}

/** The stored font files the user uploaded (WEB-FONT-01, OPFS). */
export interface FontUploadStore {
  /** The stored file names. */
  list(): Promise<readonly string[]>;
  read(name: string): Promise<Uint8Array>;
  write(name: string, bytes: Uint8Array): Promise<void>;
}

/** The platform the catalog loads fonts through. Tests pass fakes. */
export interface FontCatalogPorts {
  readonly bundled: readonly BundledFamily[];
  register(face: FontFaceRegistration): Promise<void>;
  /** Whether the faces that draw `text` in `font` are loaded (or there are none to load). */
  isLoaded(font: string, text: string): boolean;
  /** Loads the faces that draw `text` in `font`, resolving with how many are loaded. */
  load(font: string, text: string): Promise<number>;
  readonly uploads: FontUploadStore;
  /**
   * The installed families, through the Local Font Access API when the browser has it. A
   * permission refusal rejects with a `NotAllowedError`. Undefined when the browser has no such API.
   */
  readonly listLocal?: () => Promise<readonly string[]>;
}

/** The fonts the Text tool can choose from, and how they are loaded (WEB-FONT-01). */
export interface TextFonts {
  /** The family a stored setting names, or the bundled sans family when it is not available. */
  resolve(stored: unknown): string;
  /**
   * Whether the face can draw `text` now. If not, its files start loading and the listeners are
   * told when they have loaded, so the text is drawn again in its own face.
   */
  ensure(face: FontRequest, text?: string): boolean;
  subscribe(listener: () => void): () => void;
}

/** The characters of a text, once each and sorted, so texts with the same letters share a load. */
function letters(text: string): string {
  return [...new Set(Array.from(text))].sort().join("");
}

/** The order of the font list: by name, as the language sorts it, ignoring case. */
const COLLATOR = new Intl.Collator("en", { sensitivity: "base", numeric: true });

/** The file name without its extension, which is the family name of an uploaded font. */
export function familyOfFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).trim();
}

function isPermissionError(cause: unknown): boolean {
  return (
    cause instanceof DOMException &&
    (cause.name === "NotAllowedError" || cause.name === "SecurityError")
  );
}

/**
 * The font families of the Text tool (WEB-FONT-01): the bundled families, the uploaded ones and,
 * where the browser allows, the installed ones. Bundled faces are registered at start-up but their
 * files are fetched only when a face is first drawn or shown in the picker. Uploads are stored and
 * then registered, and the installed list is read only when the user asks for it. A family name
 * listed twice appears once, with the first source that offered it. The list is one, sorted by name.
 */
export class FontCatalog implements TextFonts {
  readonly #ports: FontCatalogPorts;
  readonly #listeners = new Set<() => void>();
  /** The loads asked for, by font and letters; each is tried once, so a failed one is not retried per frame. */
  readonly #requested = new Set<string>();
  #state: FontCatalogState;
  #started: Promise<void> | undefined;

  constructor(ports: FontCatalogPorts) {
    this.#ports = ports;
    this.#state = {
      families: ports.bundled
        .map((family): FontEntry => ({ family: family.family, source: "bundled" }))
        .sort(byFamily),
      local: ports.listLocal === undefined ? "unavailable" : "idle",
    };
  }

  get state(): FontCatalogState {
    return this.#state;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  resolve(stored: unknown): string {
    const names = this.#state.families.map((entry) => entry.family);
    return resolveFamily(stored, names, DEFAULT_FONT_FAMILY);
  }

  ensure(face: FontRequest, text = " "): boolean {
    const font = cssFontOf(face);
    const sample = text === "" ? " " : text;
    if (this.#ports.isLoaded(font, sample)) return true;
    const key = `${font}\n${letters(sample)}`;
    if (this.#requested.has(key)) return false;
    this.#requested.add(key);
    this.#ports.load(font, sample).then(
      (loaded) => {
        if (loaded > 0) this.#set({});
      },
      () => {
        // The face stays unloaded (e.g. offline before first use); the text keeps its fallback.
      },
    );
    return false;
  }

  /**
   * Registers the bundled faces and the uploaded fonts. Repeated calls share the first run. A face
   * that fails to register is skipped, so one bad file does not hide the other families.
   */
  start(): Promise<void> {
    this.#started ??= this.#load();
    return this.#started;
  }

  /** Stores an uploaded font and makes it available under its file name's family. */
  async addUpload(name: string, bytes: Uint8Array): Promise<string> {
    const family = familyOfFileName(name);
    if (family === "") throw new Error("The font file has no name.");
    await this.#ports.uploads.write(name, bytes);
    await this.#ports.register({ family, weight: 400, style: "normal", data: bytes });
    this.#add(family, "uploaded");
    return family;
  }

  /** Reads the installed families, where the browser allows it. */
  async loadLocal(): Promise<void> {
    const list = this.#ports.listLocal;
    if (list === undefined) return;
    this.#set({ local: "loading" });
    try {
      const names = await list();
      for (const name of [...names].sort(COLLATOR.compare)) this.#add(name, "local");
      this.#set({ local: "ready" });
    } catch (cause) {
      this.#set({ local: isPermissionError(cause) ? "denied" : "unavailable" });
    }
  }

  async #load(): Promise<void> {
    for (const family of this.#ports.bundled) {
      for (const face of family.faces) {
        await this.#registerSafely({
          family: family.family,
          weight: face.weight,
          style: face.style,
          data: face.url,
          ...(face.unicodeRange === undefined ? {} : { unicodeRange: face.unicodeRange }),
        });
      }
    }
    this.#set({});
    const names = await this.#listUploads();
    for (const name of names) {
      try {
        const bytes = await this.#ports.uploads.read(name);
        const family = familyOfFileName(name);
        await this.#ports.register({ family, weight: 400, style: "normal", data: bytes });
        this.#add(family, "uploaded");
      } catch {
        // A stored file that cannot be read is left out of the list.
      }
    }
    this.#set({});
  }

  async #registerSafely(face: FontFaceRegistration): Promise<void> {
    try {
      await this.#ports.register(face);
    } catch {
      // The family still has its other faces, and the canvas falls back for this one.
    }
  }

  async #listUploads(): Promise<readonly string[]> {
    try {
      return await this.#ports.uploads.list();
    } catch {
      return [];
    }
  }

  /** Adds a family unless its name is already listed. */
  #add(family: string, source: FontSource): void {
    if (this.#state.families.some((entry) => entry.family === family)) return;
    this.#set({ families: [...this.#state.families, { family, source }].sort(byFamily) });
  }

  #set(patch: Partial<FontCatalogState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
}

function byFamily(a: FontEntry, b: FontEntry): number {
  return COLLATOR.compare(a.family, b.family);
}
