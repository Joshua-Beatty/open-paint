import type { SettingsStore } from "@openpaint/storage";
import { useCallback, useRef, useSyncExternalStore } from "react";

/** The part of the settings store a component reads. */
export type SettingReader = Pick<SettingsStore, "get" | "onChange">;

interface Snapshot {
  readonly json: string | undefined;
  readonly value: ReturnType<SettingReader["get"]>;
}

/**
 * Reads one setting and re-renders when it changes, including changes from other tabs (WEB-UI-07).
 * Before the store opens, the value is undefined and the caller shows its default. Object values
 * (colours, JSON) are copied on every read, so the snapshot keeps its identity while the value is
 * unchanged, or React would re-render without end.
 */
export function useSetting(
  settings: SettingReader | null,
  path: string,
): ReturnType<SettingReader["get"]> {
  const subscribe = useCallback(
    (notify: () => void) => settings?.onChange(() => notify()) ?? (() => {}),
    [settings],
  );
  const cache = useRef<Snapshot | undefined>(undefined);
  const read = useCallback(() => {
    const value = settings?.get(path);
    const json = value === undefined ? undefined : JSON.stringify(value);
    if (cache.current === undefined || cache.current.json !== json) {
      cache.current = { json, value };
    }
    return cache.current.value;
  }, [settings, path]);
  return useSyncExternalStore(subscribe, read);
}
