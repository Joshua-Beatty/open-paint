/**
 * Keys and entries that a file format reader did not recognize (FMT-NAT-04, FMT-NAT-07, FMT-NAT-11).
 * They are kept verbatim so that the next save writes them back. Each object is the JSON object the
 * unknown keys sat in. `entries` holds unknown archive entries by path.
 */
export interface FormatExtras {
  /** Unknown top-level keys of the manifest. */
  readonly document?: Readonly<Record<string, unknown>>;
  /** Unknown keys of the `resolution` object. */
  readonly resolution?: Readonly<Record<string, unknown>>;
  /** Unknown keys of the `metadata` object. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Unknown archive entries, by path. */
  readonly entries?: Readonly<Record<string, Uint8Array>>;
}
