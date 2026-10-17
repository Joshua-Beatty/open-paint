import { findDefinition, type SettingValue } from "./definitions";
import { parseMirrored } from "./values";

/** The subset of the Web Storage API the mirror uses. */
export interface MirrorStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = "openpaint.setting.";

/** The localStorage browser default, or null where Web Storage is blocked (SET-STO-01). */
export function defaultMirror(): MirrorStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Reads an early setting (for example `ui.theme`) from the localStorage mirror, before IndexedDB
 * opens (SET-LIFE-01 step 2). Returns undefined when nothing valid is mirrored for the path.
 */
export function readEarlySetting(
  path: string,
  storage: MirrorStorage | null = defaultMirror(),
): SettingValue | undefined {
  const definition = findDefinition(path);
  if (!definition?.mirrored || !storage) return undefined;
  return parseMirrored(definition, storage.getItem(PREFIX + path));
}

/** Writes a mirrored setting's value, or removes it when the value is absent. */
export function writeMirror(
  path: string,
  value: SettingValue | undefined,
  storage: MirrorStorage,
): void {
  if (value === undefined) storage.removeItem(PREFIX + path);
  else storage.setItem(PREFIX + path, String(value));
}
