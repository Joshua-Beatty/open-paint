import { PropertyCollection, sameValue } from "@openpaint/properties";
import type { GpuPerformanceClass, SettingsStore, SettingValue } from "@openpaint/storage";
import { type ControlLayout, PropertyForm } from "@openpaint/ui";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { blockSchema, type FormBlock, fieldPaths, readField, writesOf } from "./settings-schema";
import { toPropertyValue, toStoredValue } from "./settings-values";

export interface SettingsFormProps {
  readonly block: FormBlock;
  readonly settings: SettingsStore;
  readonly gpuPerformanceClass: GpuPerformanceClass;
  /** Settings that show but cannot be changed, such as the colour scheme under forced colors. */
  readonly readOnlyPaths?: readonly string[];
  /**
   * Handles a write itself and returns true when it did, for example a backend change that also
   * resets the GPU quality default (SET-DLG-07a). Otherwise the value is stored as it is.
   */
  readonly onCommit?: (path: string, value: SettingValue) => boolean;
  /** Stacked for the Settings dialog, inline for a tool options bar. Defaults to stacked. */
  readonly layout?: ControlLayout;
}

/**
 * A group of settings shown as a generated form (EXT-06C). The controls edit a property collection
 * whose values are the stored settings. Edits are written to the store, and changes made elsewhere
 * (another control, another tab, a reset) reload the collection, so both sides always agree.
 */
export function SettingsForm({
  block,
  settings,
  gpuPerformanceClass,
  readOnlyPaths = [],
  onCommit,
  layout,
}: SettingsFormProps) {
  const [fields] = useState(() => new Map(block.fields.map((field) => [field.key, field])));
  const [keys] = useState(
    () =>
      new Map(
        block.fields.flatMap((field) =>
          fieldPaths(field).map((path) => [path, field.key] as const),
        ),
      ),
  );
  const [revision, reload] = useReducer((count: number) => count + 1, 0);
  const readOnlyKey = readOnlyPaths.join("|");
  // The revision re-creates the collection when a setting changes outside this form.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the reload trigger.
  const collection = useMemo(() => {
    const schema = blockSchema(block, { gpuPerformanceClass });
    const values = Object.fromEntries(
      block.fields.map((field) => {
        const stored = readField(field, (path) => settings.get(path));
        return [field.key, stored === undefined ? undefined : toPropertyValue(stored)];
      }),
    );
    const form = new PropertyCollection(schema, values);
    const locked = readOnlyKey.split("|");
    for (const field of block.fields) {
      if (locked.includes(field.path)) form.setReadOnly(field.key, true);
    }
    return form;
  }, [block, gpuPerformanceClass, settings, revision, readOnlyKey]);

  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  useEffect(
    () =>
      collection.on("valueChanged", ({ key, value }) => {
        const field = fields.get(key);
        if (field === undefined) return;
        for (const [path, stored] of writesOf(field, toStoredValue(value))) {
          if (commitRef.current?.(path, stored) === true) continue;
          if (!sameValue(settings.get(path), stored)) settings.set(path, stored);
        }
      }),
    [collection, fields, settings],
  );

  useEffect(
    () =>
      settings.onChange(({ path }) => {
        const key = keys.get(path);
        const field = key === undefined ? undefined : fields.get(key);
        if (key === undefined || field === undefined) return;
        const current = readField(field, (at) => settings.get(at));
        if (current === undefined) return;
        if (!sameValue(collection.get(key), toPropertyValue(current))) reload();
      }),
    [collection, fields, keys, settings],
  );

  return <PropertyForm collection={collection} layout={layout} />;
}
