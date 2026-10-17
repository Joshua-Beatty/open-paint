import type { EffectDescriptor } from "./effects";
import type { FileTypeDescriptor, FileTypeFactory, FileTypeHost } from "./file-types";
import type { ShapeDescriptor } from "./shapes";
import type { ToolDescriptor } from "./tools";
import { EXTENSION_API_MAJOR } from "./version";

/** What every registry stores: a stable id and the major API version the item targets. */
export interface RegistryItem {
  readonly id: string;
  readonly apiVersion: number;
}

/**
 * An ordered registry keyed by stable id (EXT-V1-01). Lists come back in registration order, which
 * is the order menus and pickers show.
 */
export class Registry<T extends RegistryItem> {
  readonly #kind: string;
  readonly #items = new Map<string, T>();

  constructor(kind: string) {
    this.#kind = kind;
  }

  register(item: T): void {
    this.validate(item);
    if (this.#items.has(item.id)) {
      throw new Error(`${this.#kind} "${item.id}" is already registered.`);
    }
    this.#items.set(item.id, item);
  }

  get(id: string): T | undefined {
    return this.#items.get(id);
  }

  has(id: string): boolean {
    return this.#items.has(id);
  }

  list(): readonly T[] {
    return [...this.#items.values()];
  }

  /** Subclasses add their own checks. Each check throws before the item is stored. */
  protected validate(item: T): void {
    if (item.id.length === 0) {
      throw new Error(`${this.#kind} id must not be empty.`);
    }
    if (
      !Number.isInteger(item.apiVersion) ||
      item.apiVersion < 1 ||
      item.apiVersion > EXTENSION_API_MAJOR
    ) {
      throw new Error(
        `${this.#kind} "${item.id}" targets extension API version ${item.apiVersion}, but this build supports versions 1 to ${EXTENSION_API_MAJOR}.`,
      );
    }
  }
}

/** Effects and adjustments (EXT-V1-01, EXT-02). */
export class EffectRegistry extends Registry<EffectDescriptor> {
  constructor() {
    super("Effect");
  }

  protected override validate(item: EffectDescriptor): void {
    super.validate(item);
    if (!item.configurable && item.schema.properties.length > 0) {
      throw new Error(
        `Effect "${item.id}" is not configurable, so it must not declare parameters (FX-FW-NOCONFIG-01).`,
      );
    }
  }
}

const EXTENSION_PATTERN = /^\.[a-z0-9]+$/;

/** File types (EXT-V1-01, EXT-07, FMT-REG-07). */
export class FileTypeRegistry extends Registry<FileTypeDescriptor> {
  constructor() {
    super("File type");
  }

  protected override validate(item: FileTypeDescriptor): void {
    super.validate(item);
    checkExtensions(item.id, "load", item.loadExtensions, item.capabilities.supportsLoading);
    checkExtensions(item.id, "save", item.saveExtensions, item.capabilities.supportsSaving);
  }

  /** Calls a factory (EXT-07-05) and registers every file type it returns. */
  registerFactory(factory: FileTypeFactory, host: FileTypeHost): void {
    for (const type of factory(host)) {
      this.register(type);
    }
  }
}

function checkExtensions(
  id: string,
  role: "load" | "save",
  extensions: readonly string[],
  supported: boolean,
): void {
  const action = role === "load" ? "loading" : "saving";
  if (supported && extensions.length === 0) {
    throw new Error(`File type "${id}" supports ${action} but declares no ${role} extensions.`);
  }
  if (!supported && extensions.length > 0) {
    throw new Error(
      `File type "${id}" declares ${role} extensions but does not support ${action}.`,
    );
  }
  for (const extension of extensions) {
    if (!EXTENSION_PATTERN.test(extension)) {
      throw new Error(
        `File type "${id}" has the invalid extension "${extension}". Use a lowercase, dot-prefixed suffix.`,
      );
    }
  }
}

const HOTKEY_PATTERN = /^[A-Za-z]$/;

/** Tools in the Tools panel (EXT-V1-01, TL-FRAME-07). */
export class ToolRegistry extends Registry<ToolDescriptor> {
  constructor() {
    super("Tool");
  }

  protected override validate(item: ToolDescriptor): void {
    super.validate(item);
    if (!HOTKEY_PATTERN.test(item.hotkey)) {
      throw new Error(`Tool "${item.id}" must use a single letter as its hotkey.`);
    }
  }
}

/** Shapes for the Shapes tool (EXT-V1-01, EXT-08-02). */
export class ShapeRegistry extends Registry<ShapeDescriptor> {
  constructor() {
    super("Shape");
  }

  protected override validate(item: ShapeDescriptor): void {
    super.validate(item);
    if (!/^\s*[Mm]/.test(item.geometry.path)) {
      throw new Error(
        `Shape "${item.id}" must have SVG path data that starts with a move command.`,
      );
    }
    if (item.category.length === 0) {
      throw new Error(`Shape "${item.id}" must belong to a category.`);
    }
  }
}
