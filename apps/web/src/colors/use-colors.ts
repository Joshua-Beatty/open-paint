import type { SettingsStore } from "@openpaint/storage";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Rgba } from "./color-math";
import { DEFAULT_PALETTE, PALETTE_SIZE, serializePalette } from "./palette";
import {
  deletePalette,
  importPalettes,
  type PaletteFile,
  type PaletteStorage,
  paletteNames,
  type ReplaceConfirmation,
  readPalette,
  renamePalette,
  savePalette,
} from "./palette-library";

/** The settings the Colors panel reads and writes (SET-STO-02). */
export type ColorSettings = Pick<SettingsStore, "get" | "set" | "onChange">;

export const PRIMARY_COLOR_PATH = "tools.primaryColor";
export const SECONDARY_COLOR_PATH = "tools.secondaryColor";
export const CURRENT_PALETTE_PATH = "workspace.currentPalette";

function isRgba(value: unknown): value is Rgba {
  if (typeof value !== "object" || value === null) return false;
  const color = value as Record<string, unknown>;
  return ["r", "g", "b", "a"].every((channel) => typeof color[channel] === "number");
}

/** The color stored at `path`, or `fallback` when the setting is missing or not a color. */
export function readStoredColor(settings: ColorSettings, path: string, fallback: Rgba): Rgba {
  const value = settings.get(path);
  if (!isRgba(value)) return fallback;
  return { r: value.r, g: value.g, b: value.b, a: value.a };
}

function sameColor(a: Rgba, b: Rgba): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

/** A color kept in settings (DOC-COL-01). Writes persist it and keep the state in step. */
export function useStoredColor(
  settings: ColorSettings,
  path: string,
  fallback: Rgba,
): readonly [Rgba, (color: Rgba) => void] {
  const [color, setColor] = useState(() => readStoredColor(settings, path, fallback));
  useEffect(
    () =>
      settings.onChange((change) => {
        if (change.path !== path) return;
        // A same-valued color keeps its identity, so the panel does not re-render (L3).
        const next = readStoredColor(settings, path, fallback);
        setColor((previous) => (sameColor(previous, next) ? previous : next));
      }),
    [settings, path, fallback],
  );
  const update = useCallback(
    (next: Rgba) => {
      settings.set(path, { r: next.r, g: next.g, b: next.b, a: next.a });
      setColor(next);
    },
    [settings, path],
  );
  return [color, update];
}

export interface PaletteState {
  /** The user palette names, sorted. */
  readonly names: readonly string[];
  /** The current user palette, or "" for the default palette. */
  readonly current: string;
  /** The 96 colors shown, which hold any edits made to the current palette. */
  readonly colors: readonly Rgba[];
}

export interface PaletteController {
  readonly state: PaletteState;
  /** The name whose replacement is awaiting an answer, or null. */
  readonly replacing: string | null;
  readonly answerReplace: (replace: boolean) => void;
  /** Loads a user palette by name, or the default palette when the name is "". */
  readonly select: (name: string) => Promise<void>;
  /** Saves the shown colors as a palette and makes it current. Returns whether it was saved. */
  readonly save: (name: string) => Promise<boolean>;
  /** Renames a user palette. Returns whether it was renamed. */
  readonly rename: (from: string, to: string) => Promise<boolean>;
  /** Deletes a user palette. Deleting the current one makes the default palette current. */
  readonly remove: (name: string) => Promise<void>;
  readonly importFiles: (files: readonly PaletteFile[]) => Promise<void>;
  /** The file text of the shown colors, for Export Current Palette (WEB-FILE-02). */
  readonly exportText: () => string;
  /** Stores a color in a slot. Deleting a slot stores white, the empty color of the format. */
  readonly setColor: (index: number, color: Rgba) => void;
}

/** Runs a storage call and returns the fallback when the storage cannot be read. */
async function readNames(storage: PaletteStorage): Promise<string[]> {
  try {
    return await paletteNames(storage);
  } catch {
    return [];
  }
}

/**
 * The palettes of the Colors panel (DOC-COL-03, DOC-COL-04). The current palette is persisted in
 * settings. Edits go to the current user palette's file, and an edit to the default palette lasts
 * until the palette changes.
 */
export function usePalettes(storage: PaletteStorage, settings: ColorSettings): PaletteController {
  const [state, setState] = useState<PaletteState>({
    names: [],
    current: "",
    colors: DEFAULT_PALETTE,
  });
  const latest = useRef(state);
  latest.current = state;
  const pending = useRef<((replace: boolean) => void) | null>(null);
  const [replacing, setReplacing] = useState<string | null>(null);

  const confirm: ReplaceConfirmation = useCallback(
    (name) =>
      new Promise<boolean>((resolve) => {
        pending.current = resolve;
        setReplacing(name);
      }),
    [],
  );
  const answerReplace = useCallback((replace: boolean) => {
    pending.current?.(replace);
    pending.current = null;
    setReplacing(null);
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      const names = await readNames(storage);
      const wanted = settings.get(CURRENT_PALETTE_PATH);
      const requested = typeof wanted === "string" ? wanted : "";
      let current = "";
      let colors: readonly Rgba[] = DEFAULT_PALETTE;
      if (requested !== "" && names.includes(requested)) {
        const loaded = await readPalette(storage, requested).catch(() => undefined);
        if (loaded !== undefined) {
          current = requested;
          colors = loaded;
        }
      }
      if (current !== requested) settings.set(CURRENT_PALETTE_PATH, current);
      if (active) setState({ names, current, colors });
    })();
    return () => {
      active = false;
    };
  }, [storage, settings]);

  const setCurrent = useCallback(
    (current: string, colors: readonly Rgba[]) => {
      settings.set(CURRENT_PALETTE_PATH, current);
      setState((previous) => ({ ...previous, current, colors }));
    },
    [settings],
  );
  const refreshNames = useCallback(async () => {
    const names = await readNames(storage);
    setState((previous) => ({ ...previous, names }));
  }, [storage]);

  const select = useCallback(
    async (name: string) => {
      if (name === "") {
        setCurrent("", DEFAULT_PALETTE);
        return;
      }
      const loaded = await readPalette(storage, name);
      if (loaded === undefined) {
        await refreshNames();
        return;
      }
      setCurrent(name, loaded);
    },
    [storage, setCurrent, refreshNames],
  );

  const save = useCallback(
    async (name: string) => {
      const colors = latest.current.colors;
      const saved = await savePalette(storage, name, colors, confirm);
      if (!saved) return false;
      await refreshNames();
      setCurrent(name.trim(), colors);
      return true;
    },
    [storage, confirm, refreshNames, setCurrent],
  );

  const rename = useCallback(
    async (from: string, to: string) => {
      if (from === "") return false;
      const renamed = await renamePalette(storage, from, to, confirm);
      if (!renamed) return false;
      await refreshNames();
      if (latest.current.current === from) setCurrent(to.trim(), latest.current.colors);
      return true;
    },
    [storage, confirm, refreshNames, setCurrent],
  );

  const remove = useCallback(
    async (name: string) => {
      if (name === "") return;
      await deletePalette(storage, name);
      await refreshNames();
      if (latest.current.current === name) setCurrent("", DEFAULT_PALETTE);
    },
    [storage, refreshNames, setCurrent],
  );

  const importFiles = useCallback(
    async (files: readonly PaletteFile[]) => {
      await importPalettes(storage, files, confirm);
      await refreshNames();
    },
    [storage, confirm, refreshNames],
  );

  const exportText = useCallback(() => serializePalette(latest.current.colors), []);

  const setColor = useCallback(
    (index: number, color: Rgba) => {
      if (index < 0 || index >= PALETTE_SIZE) return;
      const { current, colors } = latest.current;
      const next = colors.map((existing, slot) => (slot === index ? color : existing));
      latest.current = { ...latest.current, colors: next };
      setState((previous) => ({ ...previous, colors: next }));
      if (current !== "") void storage.write(current, serializePalette(next));
    },
    [storage],
  );

  return {
    state,
    replacing,
    answerReplace,
    select,
    save,
    rename,
    remove,
    importFiles,
    exportText,
    setColor,
  };
}
