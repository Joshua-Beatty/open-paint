import {
  BUILTIN_EFFECT_SUBMENUS,
  type BuiltinEffectSubmenu,
  type EffectMenu,
  type EffectMenuItem,
  type EffectRegistry,
  effectMenu,
} from "@openpaint/extension-api";
import type { MessageId, MessageValues, Translate } from "@openpaint/i18n";
import type { BuiltInCommandId } from "../commands/catalog";

/** The main menu bar, in order (UI-MENU, section 4). Help lives in the aux menu. */
export const MENU_NAMES = [
  "file",
  "edit",
  "view",
  "image",
  "layers",
  "adjustments",
  "effects",
] as const;

export type MenuName = (typeof MENU_NAMES)[number];

const MENU_TITLES: Readonly<Record<MenuName, MessageId>> = {
  file: "menu.bar.file",
  edit: "menu.bar.edit",
  view: "menu.bar.view",
  image: "menu.bar.image",
  layers: "menu.bar.layers",
  adjustments: "menu.bar.adjustments",
  effects: "menu.bar.effects",
};

const SUBMENU_LABELS: Readonly<Record<BuiltinEffectSubmenu, MessageId>> = {
  artistic: "menu.submenu.artistic",
  blurs: "menu.submenu.blurs",
  color: "menu.submenu.color",
  distort: "menu.submenu.distort",
  noise: "menu.submenu.noise",
  object: "menu.submenu.object",
  photo: "menu.submenu.photo",
  render: "menu.submenu.render",
  stylize: "menu.submenu.stylize",
};

/**
 * Adjustments with a shortcut in UI-MENU-ADJ, keyed by adjustment id. The shortcut is the
 * catalog command's, so the key works before the menu is ever opened.
 */
export const ADJUSTMENT_COMMANDS: Readonly<Partial<Record<string, BuiltInCommandId>>> = {
  autoLevel: "adjustments.autoLevel",
  blackAndWhite: "adjustments.blackAndWhite",
  brightnessContrast: "adjustments.brightnessContrast",
  curves: "adjustments.curves",
  hueSaturation: "adjustments.hueSaturation",
  invertAlpha: "adjustments.invertAlpha",
  invertColors: "adjustments.invertColors",
  levels: "adjustments.levels",
  posterize: "adjustments.posterize",
  sepia: "adjustments.sepia",
};

/** What the menus need to know about the app. Every field is a plain value. */
export interface MenuViewState {
  readonly fitToWindow: boolean;
  readonly pixelGrid: boolean;
  readonly rulers: boolean;
  readonly units: "pixels" | "inches" | "centimeters";
  readonly fullScreen: boolean;
}

export interface MenuState {
  /** An image is open and active (UI-MENU "Doc"). */
  readonly hasDocument: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly hasSelection: boolean;
  readonly activeLayerIsBitmap: boolean;
  readonly layerCount: number;
  /** Counted from the bottom, so 0 is the bottom layer. */
  readonly activeLayerIndex: number;
  /** At least one open image has unsaved changes. */
  readonly anyUnsaved: boolean;
  readonly clipboardHasImage: boolean;
  readonly clipboardHasSelection: boolean;
  /** Effects can run on the active image. */
  readonly canRunEffects: boolean;
  /** The effect that ran most recently in this session, for "Repeat". */
  readonly lastEffectId?: string | undefined;
  /** The Open Recent list, newest first (FMT-OPEN-06). */
  readonly recent: readonly MenuRecentEntry[];
  readonly view: MenuViewState;
  readonly fullScreenAvailable: boolean;
}

/** One Open Recent entry as the menu shows it: its id, name and PNG thumbnail data URL. */
export interface MenuRecentEntry {
  readonly id: number;
  readonly name: string;
  readonly thumbnail?: string | undefined;
}

/** The state with no image open, which is what the app has until documents exist. */
export const NO_IMAGE_MENU_STATE: MenuState = {
  hasDocument: false,
  canUndo: false,
  canRedo: false,
  hasSelection: false,
  activeLayerIsBitmap: false,
  layerCount: 0,
  activeLayerIndex: 0,
  anyUnsaved: false,
  clipboardHasImage: false,
  clipboardHasSelection: false,
  canRunEffects: false,
  recent: [],
  view: { fitToWindow: false, pixelGrid: false, rulers: false, units: "pixels", fullScreen: false },
  fullScreenAvailable: false,
};

/** The commands the menus read: whether one can run now, and its shortcut labels. */
export interface MenuCommands {
  isEnabled(id: BuiltInCommandId): boolean;
  labels(id: BuiltInCommandId): { readonly shortcuts: readonly string[] };
}

export interface MenuContext {
  readonly state: MenuState;
  readonly effects: EffectRegistry;
  readonly commands: MenuCommands;
  readonly t: Translate;
  /**
   * Whether the active tool takes pasted text right now (UI-MENU-EDIT, the Paste fallback). It is
   * read when a menu is built, so the state is current when the menu opens.
   */
  readonly toolAcceptsPaste: () => boolean;
}

export type MenuAction =
  | { readonly type: "command"; readonly command: BuiltInCommandId }
  | { readonly type: "effect"; readonly effect: string }
  | { readonly type: "recent"; readonly id: number };

export interface MenuItemEntry {
  readonly kind: "item";
  readonly id: string;
  /** The translated label, with "&" before the access key. */
  readonly label: string;
  readonly shortcut?: string | undefined;
  readonly enabled: boolean;
  readonly checked: boolean;
  readonly action?: MenuAction | undefined;
  /** A picture shown before the label, such as an Open Recent thumbnail. */
  readonly thumbnail?: string | undefined;
}

export interface MenuGroupEntry {
  readonly kind: "group";
  readonly id: string;
  readonly label: string;
  readonly entries: readonly MenuEntry[];
}

export interface MenuSeparatorEntry {
  readonly kind: "separator";
}

export type MenuEntry = MenuItemEntry | MenuGroupEntry | MenuSeparatorEntry;

const SEPARATOR: MenuSeparatorEntry = { kind: "separator" };

export interface AccessLabelParts {
  readonly before: string;
  readonly accessKey?: string | undefined;
  readonly after: string;
}

/** Splits a label at its access key, the character after the first "&" (UI-MENU). */
export function splitAccessKey(text: string): AccessLabelParts {
  const index = text.indexOf("&");
  if (index < 0 || index === text.length - 1) return { before: text, after: "" };
  return {
    before: text.slice(0, index),
    accessKey: text.charAt(index + 1),
    after: text.slice(index + 2),
  };
}

/** A label without its access-key marker, for accessible names and typeahead. */
export function plainLabel(text: string): string {
  const parts = splitAccessKey(text);
  return `${parts.before}${parts.accessKey ?? ""}${parts.after}`;
}

export function menuTitle(name: MenuName, t: Translate): string {
  return t(MENU_TITLES[name]);
}

/** The entries of one main menu. Call it when the menu opens so the enable states are current. */
export function buildMenu(name: MenuName, context: MenuContext): readonly MenuEntry[] {
  switch (name) {
    case "file":
      return fileEntries(context);
    case "edit":
      return editEntries(context);
    case "view":
      return viewEntries(context);
    case "image":
      return imageEntries(context);
    case "layers":
      return layerEntries(context);
    case "adjustments":
      return adjustmentEntries(context);
    case "effects":
      return effectsEntries(context);
  }
}

/** The Help drop-down in the aux area (UI-MENU-HELP). Language is [LATER] and is left out. */
export function buildHelpMenu(context: MenuContext): readonly MenuEntry[] {
  return [
    command(context, "help.keyboardShortcuts", "menu.help.keyboardShortcuts", true),
    command(context, "help.about", "menu.help.about", true),
  ];
}

interface CommandOptions {
  readonly checked?: boolean;
  readonly values?: MessageValues;
}

/** A command item. It is enabled when its rule holds and the command has a handler that can run. */
function command(
  context: MenuContext,
  id: BuiltInCommandId,
  key: MessageId,
  rule: boolean,
  options: CommandOptions = {},
): MenuItemEntry {
  return {
    kind: "item",
    id,
    label: context.t(key, options.values),
    shortcut: context.commands.labels(id).shortcuts[0],
    enabled: rule && context.commands.isEnabled(id),
    checked: options.checked ?? false,
    action: { type: "command", command: id },
  };
}

function fileEntries(context: MenuContext): readonly MenuEntry[] {
  const s = context.state;
  return [
    command(context, "file.new", "menu.file.new", true),
    command(context, "file.open", "menu.file.open", true),
    {
      kind: "group",
      id: "file.recent",
      label: context.t("menu.file.recent"),
      entries: [
        ...(s.recent.length === 0
          ? [
              {
                kind: "item" as const,
                id: "file.recent.none",
                label: context.t("menu.file.recentNone"),
                enabled: false,
                checked: false,
              },
            ]
          : s.recent.map(
              (entry): MenuItemEntry => ({
                kind: "item",
                id: `file.recent.${entry.id}`,
                label: entry.name.replaceAll("&", ""),
                enabled: true,
                checked: false,
                thumbnail: entry.thumbnail,
                action: { type: "recent", id: entry.id },
              }),
            )),
        SEPARATOR,
        command(context, "file.clearRecent", "menu.file.clearRecent", s.recent.length > 0),
      ],
    },
    SEPARATOR,
    command(context, "file.save", "menu.file.save", s.hasDocument),
    command(context, "file.saveAs", "menu.file.saveAs", s.hasDocument),
    command(context, "file.saveAll", "menu.file.saveAll", s.anyUnsaved),
    SEPARATOR,
    command(context, "file.print", "menu.file.print", s.hasDocument),
    SEPARATOR,
    command(context, "file.close", "menu.file.close", s.hasDocument),
    command(context, "file.closeAll", "menu.file.closeAll", s.hasDocument),
  ];
}

function editEntries(context: MenuContext): readonly MenuEntry[] {
  const s = context.state;
  const selection = s.hasDocument && s.hasSelection;
  const pasteSelection = s.hasDocument && s.clipboardHasSelection;
  return [
    command(context, "edit.undo", "menu.edit.undo", s.hasDocument && s.canUndo),
    command(context, "edit.redo", "menu.edit.redo", s.hasDocument && s.canRedo),
    SEPARATOR,
    command(context, "edit.cut", "menu.edit.cut", selection && s.activeLayerIsBitmap),
    command(context, "edit.copy", "menu.edit.copy", s.hasDocument),
    command(context, "edit.copyMerged", "menu.edit.copyMerged", s.hasDocument),
    command(
      context,
      "edit.paste",
      "menu.edit.paste",
      s.hasDocument && (s.clipboardHasImage || context.toolAcceptsPaste()),
    ),
    command(
      context,
      "edit.pasteIntoNewLayer",
      "menu.edit.pasteIntoNewLayer",
      s.hasDocument && s.clipboardHasImage,
    ),
    command(context, "edit.pasteIntoNewImage", "menu.edit.pasteIntoNewImage", s.clipboardHasImage),
    SEPARATOR,
    command(context, "edit.copySelection", "menu.edit.copySelection", s.hasSelection),
    {
      kind: "group",
      id: "edit.pasteSelection",
      label: context.t("menu.edit.pasteSelection"),
      entries: [
        command(
          context,
          "edit.pasteSelectionReplace",
          "menu.edit.pasteSelectionReplace",
          pasteSelection,
        ),
        command(context, "edit.pasteSelectionAdd", "menu.edit.pasteSelectionAdd", pasteSelection),
        command(
          context,
          "edit.pasteSelectionExclude",
          "menu.edit.pasteSelectionExclude",
          pasteSelection,
        ),
        command(
          context,
          "edit.pasteSelectionIntersect",
          "menu.edit.pasteSelectionIntersect",
          pasteSelection,
        ),
        command(context, "edit.pasteSelectionXor", "menu.edit.pasteSelectionXor", pasteSelection),
      ],
    },
    SEPARATOR,
    command(context, "edit.eraseSelection", "menu.edit.eraseSelection", selection),
    command(context, "edit.fillPrimary", "menu.edit.fillSelection", s.hasDocument),
    command(context, "edit.invertSelection", "menu.edit.invertSelection", selection),
    command(context, "edit.selectAll", "menu.edit.selectAll", s.hasDocument),
    command(context, "edit.deselect", "menu.edit.deselect", selection),
  ];
}

function viewEntries(context: MenuContext): readonly MenuEntry[] {
  const s = context.state;
  const { view } = s;
  return [
    command(context, "view.zoomIn", "menu.view.zoomIn", s.hasDocument),
    command(context, "view.zoomOut", "menu.view.zoomOut", s.hasDocument),
    command(context, "view.zoomToWindow", "menu.view.zoomToWindow", s.hasDocument, {
      checked: view.fitToWindow,
    }),
    command(
      context,
      "view.zoomToSelection",
      "menu.view.zoomToSelection",
      s.hasDocument && s.hasSelection,
    ),
    command(context, "view.actualSize", "menu.view.actualSize", s.hasDocument),
    SEPARATOR,
    command(context, "view.pixelGrid", "menu.view.pixelGrid", s.hasDocument, {
      checked: view.pixelGrid,
    }),
    command(context, "view.rulers", "menu.view.rulers", s.hasDocument, { checked: view.rulers }),
    SEPARATOR,
    command(context, "view.unitsPixels", "menu.view.pixels", s.hasDocument, {
      checked: view.units === "pixels",
    }),
    command(context, "view.unitsInches", "menu.view.inches", s.hasDocument, {
      checked: view.units === "inches",
    }),
    command(context, "view.unitsCentimeters", "menu.view.centimeters", s.hasDocument, {
      checked: view.units === "centimeters",
    }),
    SEPARATOR,
    command(context, "view.fullScreen", "menu.view.fullScreen", s.fullScreenAvailable, {
      checked: view.fullScreen,
    }),
  ];
}

function imageEntries(context: MenuContext): readonly MenuEntry[] {
  const s = context.state;
  return [
    command(context, "image.crop", "menu.image.crop", s.hasDocument && s.hasSelection),
    command(context, "image.resize", "menu.image.resize", s.hasDocument),
    command(context, "image.canvasSize", "menu.image.canvasSize", s.hasDocument),
    SEPARATOR,
    command(context, "image.flipHorizontal", "menu.image.flipHorizontal", s.hasDocument),
    command(context, "image.flipVertical", "menu.image.flipVertical", s.hasDocument),
    SEPARATOR,
    command(context, "image.rotate90Cw", "menu.image.rotate90Cw", s.hasDocument),
    command(context, "image.rotate90Ccw", "menu.image.rotate90Ccw", s.hasDocument),
    command(context, "image.rotate180", "menu.image.rotate180", s.hasDocument),
    SEPARATOR,
    command(context, "image.flatten", "menu.image.flatten", s.hasDocument && s.layerCount > 1),
  ];
}

function layerEntries(context: MenuContext): readonly MenuEntry[] {
  const s = context.state;
  const doc = s.hasDocument;
  const canMoveUp = doc && s.activeLayerIndex < s.layerCount - 1;
  const canMoveDown = doc && s.activeLayerIndex > 0;
  return [
    command(context, "layers.add", "menu.layers.add", doc),
    command(context, "layers.delete", "menu.layers.delete", doc && s.layerCount > 1),
    command(context, "layers.duplicate", "menu.layers.duplicate", doc),
    command(context, "layers.mergeDown", "menu.layers.mergeDown", canMoveDown),
    command(context, "layers.toggleVisibility", "menu.layers.toggleVisibility", doc),
    SEPARATOR,
    command(context, "layers.importFromFile", "menu.layers.importFromFile", doc),
    SEPARATOR,
    command(context, "layers.flipHorizontal", "menu.layers.flipHorizontal", doc),
    command(context, "layers.flipVertical", "menu.layers.flipVertical", doc),
    command(context, "layers.rotate180", "menu.layers.rotate180", doc),
    command(context, "layers.rotateZoom", "menu.layers.rotateZoom", doc),
    SEPARATOR,
    command(context, "layers.goTop", "menu.layers.goTop", canMoveUp),
    command(context, "layers.goAbove", "menu.layers.goAbove", canMoveUp),
    command(context, "layers.goBelow", "menu.layers.goBelow", canMoveDown),
    command(context, "layers.goBottom", "menu.layers.goBottom", canMoveDown),
    SEPARATOR,
    command(context, "layers.moveTop", "menu.layers.moveTop", canMoveUp),
    command(context, "layers.moveUp", "menu.layers.moveUp", canMoveUp),
    command(context, "layers.moveDown", "menu.layers.moveDown", canMoveDown),
    command(context, "layers.moveBottom", "menu.layers.moveBottom", canMoveDown),
    SEPARATOR,
    command(context, "layers.properties", "menu.layers.properties", doc),
  ];
}

function adjustmentEntries(context: MenuContext): readonly MenuEntry[] {
  return effectEntries(
    context,
    effectMenu(context.effects, "adjustment", context.t),
    (id) => ADJUSTMENT_COMMANDS[id],
  );
}

function effectsEntries(context: MenuContext): readonly MenuEntry[] {
  const { state, effects } = context;
  const last = state.lastEffectId === undefined ? undefined : effects.get(state.lastEffectId);
  const repeat: readonly MenuEntry[] =
    last === undefined
      ? []
      : [
          command(
            context,
            "effects.repeat",
            "menu.effects.repeat",
            state.hasDocument && state.canRunEffects,
            { values: { effect: context.t(last.label) } },
          ),
          SEPARATOR,
        ];
  return [
    ...repeat,
    ...effectEntries(context, effectMenu(effects, "effect", context.t), () => undefined),
  ];
}

/** Effect items grouped by submenu, then the items without one (UI-MENU-FX). */
function effectEntries(
  context: MenuContext,
  menu: EffectMenu,
  shortcutOf: (id: string) => BuiltInCommandId | undefined,
): readonly MenuEntry[] {
  const enabled = context.state.hasDocument && context.state.canRunEffects;
  const item = (entry: EffectMenuItem): MenuItemEntry => {
    const shortcutCommand = shortcutOf(entry.id);
    return {
      kind: "item",
      id: `effect:${entry.id}`,
      label: entry.title,
      shortcut:
        shortcutCommand === undefined
          ? undefined
          : context.commands.labels(shortcutCommand).shortcuts[0],
      enabled,
      checked: false,
      action: { type: "effect", effect: entry.id },
    };
  };
  return [
    ...menu.submenus.map(
      (group): MenuGroupEntry => ({
        kind: "group",
        id: `submenu:${group.name}`,
        label: submenuLabel(group.name, context.t),
        entries: group.items.map(item),
      }),
    ),
    ...menu.items.map(item),
  ];
}

/** The buttons of the common-actions strip, in UI-TB-01 order, with their tooltip names. */
const COMMON_ACTIONS: readonly (
  | { readonly id: BuiltInCommandId; readonly name: MessageId }
  | MenuSeparatorEntry
)[] = [
  { id: "file.new", name: "shell.common.new" },
  { id: "file.open", name: "shell.common.open" },
  { id: "file.save", name: "shell.common.save" },
  { id: "file.saveAll", name: "shell.common.saveAll" },
  SEPARATOR,
  { id: "file.print", name: "shell.common.print" },
  SEPARATOR,
  { id: "edit.cut", name: "shell.common.cut" },
  { id: "edit.copy", name: "shell.common.copy" },
  { id: "edit.paste", name: "shell.common.paste" },
  { id: "image.crop", name: "shell.common.crop" },
  { id: "edit.deselect", name: "shell.common.deselect" },
  SEPARATOR,
  { id: "edit.undo", name: "shell.common.undo" },
  { id: "edit.redo", name: "shell.common.redo" },
  SEPARATOR,
  { id: "view.pixelGrid", name: "shell.common.pixelGrid" },
  { id: "view.rulers", name: "shell.common.rulers" },
];

/** The menus that hold the commands of the common-actions strip. */
const COMMON_ACTION_MENUS: readonly MenuName[] = ["file", "edit", "view", "image"];

/** One button of the common-actions strip, as plain values so a change is cheap to detect. */
export interface CommonActionEntry {
  readonly kind: "action";
  readonly id: BuiltInCommandId;
  /** The tooltip and accessible name (UI-TB-01). */
  readonly name: string;
  readonly shortcut?: string | undefined;
  readonly enabled: boolean;
  /** A toggle button: View › Pixel grid and View › Rulers. */
  readonly toggle: boolean;
  readonly checked: boolean;
}

export type CommonActionsEntry = CommonActionEntry | MenuSeparatorEntry;

function collectItems(entries: readonly MenuEntry[], into: Map<string, MenuItemEntry>): void {
  for (const entry of entries) {
    if (entry.kind === "item") into.set(entry.id, entry);
    else if (entry.kind === "group") collectItems(entry.entries, into);
  }
}

/**
 * The common-actions strip (UI-TB-01). Each button takes its enabled, checked and shortcut state
 * from its menu item, so the strip and the menus always agree.
 */
export function commonActions(context: MenuContext): readonly CommonActionsEntry[] {
  const items = new Map<string, MenuItemEntry>();
  for (const name of COMMON_ACTION_MENUS) collectItems(buildMenu(name, context), items);
  return COMMON_ACTIONS.map((action): CommonActionsEntry => {
    if ("kind" in action) return action;
    const item = items.get(action.id);
    return {
      kind: "action",
      id: action.id,
      name: context.t(action.name),
      shortcut: item?.shortcut,
      enabled: item?.enabled === true,
      toggle: action.id === "view.pixelGrid" || action.id === "view.rulers",
      checked: item?.checked === true,
    };
  });
}

function submenuLabel(name: string, t: Translate): string {
  return isBuiltinSubmenu(name) ? t(SUBMENU_LABELS[name]) : name;
}

function isBuiltinSubmenu(name: string): name is BuiltinEffectSubmenu {
  return (BUILTIN_EFFECT_SUBMENUS as readonly string[]).includes(name);
}
