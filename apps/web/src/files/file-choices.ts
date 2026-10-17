import type { FileTypeDescriptor } from "@openpaint/extension-api";
import type { Translate } from "@openpaint/i18n";
import type { PickerType } from "./file-access";

/** The extension of a file name with its dot, in lower case, or "" when the name has none. */
export function extensionOf(name: string): string {
  const match = /\.[a-z0-9]{1,8}$/i.exec(name);
  return match === null || match.index === 0 ? "" : match[0].toLowerCase();
}

/**
 * The Open picker's lists (FMT-OPEN-01): "All image types" with every loadable extension, one
 * entry per loadable type in registry order, then "All Files".
 */
export function openPickerTypes(types: readonly FileTypeDescriptor[], t: Translate): PickerType[] {
  return [
    {
      description: t("file.allImages"),
      mimeTypes: unique(types.flatMap((type) => type.mimeTypes)),
      extensions: unique(types.flatMap((type) => type.loadExtensions)),
    },
    ...types.map((type) => ({
      description: t(type.label),
      mimeTypes: type.mimeTypes,
      extensions: type.loadExtensions,
    })),
    { description: t("file.allFiles"), mimeTypes: ["*/*"], extensions: [] },
  ];
}

/** The Save As type list: one entry per savable type, with the first entry the current type. */
export function savePickerTypes(types: readonly FileTypeDescriptor[], t: Translate): PickerType[] {
  return types.map((type) => ({
    description: t(type.label),
    mimeTypes: type.mimeTypes,
    extensions: type.saveExtensions,
  }));
}

/**
 * The name a Save As prompt suggests (FMT-SAVE-01): the name with its extension replaced by the
 * type's default save extension. An untitled image is "Untitled" with that extension.
 */
export function suggestedName(name: string, type: FileTypeDescriptor): string {
  const base = name.slice(0, name.length - extensionOf(name).length);
  return `${base}${type.saveExtensions[0] ?? ""}`;
}

/**
 * The type a chosen name picks (FMT-SAVE-01): the savable type that owns its extension, or the
 * selected type when none does.
 */
export function typeOfName(
  name: string,
  types: readonly FileTypeDescriptor[],
  selected: FileTypeDescriptor,
): FileTypeDescriptor {
  const extension = extensionOf(name);
  return types.find((type) => type.saveExtensions.includes(extension)) ?? selected;
}

/**
 * A name typed in the download dialog, with the selected type's default extension added when the
 * name owns no savable extension (FMT-SAVE-01).
 */
export function resolveDownloadName(
  name: string,
  types: readonly FileTypeDescriptor[],
  selected: FileTypeDescriptor,
): { readonly name: string; readonly type: FileTypeDescriptor } {
  const owner = types.find((type) => type.saveExtensions.includes(extensionOf(name)));
  if (owner !== undefined) return { name, type: owner };
  return { name: `${name}${selected.saveExtensions[0] ?? ""}`, type: selected };
}

/** A type of the download dialog's list: an id and its save extensions, the default first. */
interface NamedType {
  readonly id: string;
  readonly extensions: readonly string[];
}

/**
 * The name after the download dialog's type changes to `type`: a savable extension at its end is
 * replaced by the type's default one, so the name and the list never disagree. A name with no
 * savable extension is left as it is; saving adds the extension then.
 */
export function nameForType(name: string, types: readonly NamedType[], type: NamedType): string {
  const extension = extensionOf(name);
  if (extension === "" || !types.some((candidate) => candidate.extensions.includes(extension))) {
    return name;
  }
  if (type.extensions.includes(extension)) return name;
  return `${name.slice(0, name.length - extension.length)}${type.extensions[0] ?? ""}`;
}

/** The type a typed name's extension picks in the download dialog, or undefined when none does. */
export function typeForName<T extends NamedType>(name: string, types: readonly T[]): T | undefined {
  const extension = extensionOf(name);
  if (extension === "") return undefined;
  return types.find((type) => type.extensions.includes(extension));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
