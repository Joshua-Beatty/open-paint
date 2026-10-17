import { SettingsStore } from "@openpaint/storage";
import { useEffect, useState } from "react";

/**
 * The app's settings store, opened once. It is null until the store has opened (SET-LIFE-01), and
 * is closed when the app unmounts. If storage is unavailable the store works in memory.
 */
export function useAppSettings(): SettingsStore | null {
  const [store, setStore] = useState<SettingsStore | null>(null);
  useEffect(() => {
    let active = true;
    let opened: SettingsStore | undefined;
    void SettingsStore.open().then((settings) => {
      if (!active) {
        void settings.dispose();
        return;
      }
      opened = settings;
      setStore(settings);
    });
    return () => {
      active = false;
      void opened?.dispose();
    };
  }, []);
  return store;
}
