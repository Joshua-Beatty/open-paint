import { type MessageId, t } from "@openpaint/i18n";
import type { IconId } from "./common";
import type { EffectCategory, EffectDescriptor } from "./effects";
import type { FileTypeDescriptor } from "./file-types";
import type { EffectRegistry, FileTypeRegistry, ShapeRegistry } from "./registry";
import type { ShapeDescriptor } from "./shapes";

/** One item of the Effects or Adjustments menu (FX-FW-MENU-01). */
export interface EffectMenuItem {
  readonly id: string;
  /** Display name, with "..." when the effect shows a dialog (UI-MENU-ADJ). */
  readonly title: string;
  readonly icon: IconId;
  readonly configurable: boolean;
}

export interface EffectMenuSubmenu {
  readonly name: string;
  readonly items: readonly EffectMenuItem[];
}

/** Submenus come first, sorted by name. Items without a submenu follow them. Both sort by name. */
export interface EffectMenu {
  readonly submenus: readonly EffectMenuSubmenu[];
  readonly items: readonly EffectMenuItem[];
}

export interface ShapeCategory {
  readonly category: string;
  readonly shapes: readonly ShapeDescriptor[];
}

const collator = new Intl.Collator("en");

function compareNames(a: string, b: string): number {
  return collator.compare(a, b);
}

function menuItem(
  effect: EffectDescriptor,
  resolveLabel: (id: MessageId) => string,
): { readonly name: string; readonly item: EffectMenuItem } {
  const name = resolveLabel(effect.label);
  return {
    name,
    item: {
      id: effect.id,
      title: effect.configurable ? `${name}...` : name,
      icon: effect.icon,
      configurable: effect.configurable,
    },
  };
}

/**
 * The menu model for one category (FX-FW-MENU-01). Hidden effects never appear. Names come from
 * `resolveLabel`, which defaults to the English catalog.
 */
export function effectMenu(
  registry: EffectRegistry,
  category: Exclude<EffectCategory, "hidden"> = "effect",
  resolveLabel: (id: MessageId) => string = t,
): EffectMenu {
  const submenus = new Map<string, { name: string; item: EffectMenuItem }[]>();
  const loose: { name: string; item: EffectMenuItem }[] = [];
  for (const effect of registry.list()) {
    if (effect.category !== category) continue;
    const entry = menuItem(effect, resolveLabel);
    if (effect.submenu === undefined) {
      loose.push(entry);
      continue;
    }
    const group = submenus.get(effect.submenu) ?? [];
    group.push(entry);
    submenus.set(effect.submenu, group);
  }
  return {
    submenus: [...submenus.entries()]
      .map(([name, entries]) => ({ name, items: sortedItems(entries) }))
      .sort((a, b) => compareNames(a.name, b.name)),
    items: sortedItems(loose),
  };
}

function sortedItems(
  entries: readonly { readonly name: string; readonly item: EffectMenuItem }[],
): readonly EffectMenuItem[] {
  return [...entries].sort((a, b) => compareNames(a.name, b.name)).map((entry) => entry.item);
}

/** File types the Open dialog can load, in registration order (FMT-REG-01). */
export function openFileTypes(registry: FileTypeRegistry): readonly FileTypeDescriptor[] {
  return registry.list().filter((type) => type.capabilities.supportsLoading);
}

/** File types the Save As dialog offers, in registration order (FMT-OPEN-01). */
export function saveFileTypes(registry: FileTypeRegistry): readonly FileTypeDescriptor[] {
  return registry.list().filter((type) => type.capabilities.supportsSaving);
}

/** The "All image types" extensions of the Open dialog: every loadable extension, unique. */
export function openAcceptExtensions(registry: FileTypeRegistry): readonly string[] {
  return [...new Set(openFileTypes(registry).flatMap((type) => type.loadExtensions))];
}

/** The first loadable type that claims `extension` (FMT-OPEN-02). */
export function findOpenFileType(
  registry: FileTypeRegistry,
  extension: string,
): FileTypeDescriptor | undefined {
  const wanted = extension.toLowerCase();
  return openFileTypes(registry).find((type) => type.loadExtensions.includes(wanted));
}

/** The first type in `types` whose signature matches the file's bytes (FMT-OPEN-02). */
export function sniffFileType(
  types: readonly FileTypeDescriptor[],
  bytes: Uint8Array,
): FileTypeDescriptor | undefined {
  return types.find((type) => type.sniff?.(bytes) === true);
}

/** The first savable type that claims `extension`. */
export function findSaveFileType(
  registry: FileTypeRegistry,
  extension: string,
): FileTypeDescriptor | undefined {
  const wanted = extension.toLowerCase();
  return saveFileTypes(registry).find((type) => type.saveExtensions.includes(wanted));
}

/** The shape picker's groups, in the order each category is first registered (TL-SHAPE-02). */
export function shapeCategories(registry: ShapeRegistry): readonly ShapeCategory[] {
  const groups = new Map<string, ShapeDescriptor[]>();
  for (const shape of registry.list()) {
    const group = groups.get(shape.category) ?? [];
    group.push(shape);
    groups.set(shape.category, group);
  }
  return [...groups.entries()].map(([category, shapes]) => ({ category, shapes }));
}
