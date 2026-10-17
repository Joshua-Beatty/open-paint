/** A metadata value: text, or binary for EXIF and IPTC blocks. */
export type MetadataValue = string | Uint8Array;

/** Section separator for qualified entry names (DOC-DOC-04). */
export const METADATA_SEPARATOR = ".";

/** Ordered key/value entries. Names are compared ordinally and case-insensitively (DOC-DOC-04). */
export class MetadataMap<T extends MetadataValue = string> {
  readonly #entries = new Map<string, { readonly name: string; readonly value: T }>();

  get size(): number {
    return this.#entries.size;
  }

  get(name: string): T | undefined {
    return this.#entries.get(foldName(name))?.value;
  }

  has(name: string): boolean {
    return this.#entries.has(foldName(name));
  }

  /** Adds an entry, or replaces the value of an existing one in place (no duplicates). */
  set(name: string, value: T): void {
    this.#entries.set(foldName(name), { name, value });
  }

  delete(name: string): boolean {
    return this.#entries.delete(foldName(name));
  }

  clear(): void {
    this.#entries.clear();
  }

  /** Entries in insertion order, with the name as it was first written. */
  *entries(): IterableIterator<[string, T]> {
    for (const { name, value } of this.#entries.values()) yield [name, value];
  }

  /** A copy with its own binary buffers, so edits to either side stay independent. */
  clone(): MetadataMap<T> {
    const copy = new MetadataMap<T>();
    copyEntries(this, copy);
    return copy;
  }
}

function foldName(name: string): string {
  return name.toLowerCase();
}

function copyEntries<T extends MetadataValue>(from: MetadataMap<T>, to: MetadataMap<T>): void {
  for (const [name, value] of from.entries()) {
    to.set(name, (value instanceof Uint8Array ? value.slice() : value) as T);
  }
}

/**
 * Document metadata sections (DOC-DOC-04). Multiple EXIF and IPTC items and XMP packets are
 * entries with unique names (XMP packets are named by their index). `user` holds free-form
 * key/value strings that file types use for their own data.
 */
export class MetadataStore {
  readonly exif = new MetadataMap<MetadataValue>();
  readonly iptc = new MetadataMap<MetadataValue>();
  readonly xmp = new MetadataMap<MetadataValue>();
  readonly user = new MetadataMap<string>();
  /** The custom XML header the native format stores (DOC-DOC-04). */
  xmlHeader: string | undefined;

  clone(): MetadataStore {
    const copy = new MetadataStore();
    copyEntries(this.exif, copy.exif);
    copyEntries(this.iptc, copy.iptc);
    copyEntries(this.xmp, copy.xmp);
    copyEntries(this.user, copy.user);
    copy.xmlHeader = this.xmlHeader;
    return copy;
  }
}
