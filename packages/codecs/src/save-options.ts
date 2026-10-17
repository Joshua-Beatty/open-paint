/**
 * The "Remove metadata" option (FMT-OPT-ALL-01). Every savable flat format ends its option panel
 * with it, default off, so metadata is kept unless the user asks otherwise. It is written as a
 * literal `as const` so the descriptor's `saveOptions` type checks it without a properties import.
 */
export const REMOVE_METADATA_PROPERTY = {
  kind: "boolean",
  key: "removeMetadata",
  label: "fileOption.removeMetadata",
  defaultValue: false,
} as const;
