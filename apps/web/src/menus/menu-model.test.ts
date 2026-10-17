import {
  GAUSSIAN_BLUR_ID,
  gaussianBlurDescriptor,
  registerBuiltinEffects,
} from "@openpaint/effects";
import { EffectRegistry } from "@openpaint/extension-api";
import { t } from "@openpaint/i18n";
import { describe, expect, it } from "vitest";
import { BUILT_IN_REGISTRY, type BuiltInCommandId } from "../commands/catalog";
import { platformFromName } from "../commands/keys";
import { ShortcutController } from "../commands/shortcuts";
import {
  buildHelpMenu,
  buildMenu,
  commonActions,
  MENU_NAMES,
  type MenuContext,
  type MenuEntry,
  type MenuItemEntry,
  type MenuState,
  menuTitle,
  NO_IMAGE_MENU_STATE,
  plainLabel,
  splitAccessKey,
} from "./menu-model";

function controllerWith(
  ids: readonly BuiltInCommandId[] | "all",
): ShortcutController<BuiltInCommandId> {
  const controller = new ShortcutController(BUILT_IN_REGISTRY, platformFromName("Win32"));
  for (const definition of BUILT_IN_REGISTRY.list()) {
    if (ids === "all" || ids.includes(definition.id)) {
      controller.register(definition.id, { run: () => undefined });
    }
  }
  return controller;
}

function context(
  overrides: Partial<MenuState> = {},
  options: {
    effects?: EffectRegistry;
    commands?: ShortcutController<BuiltInCommandId>;
    toolAcceptsPaste?: boolean;
  } = {},
): MenuContext {
  return {
    state: { ...NO_IMAGE_MENU_STATE, ...overrides },
    effects: options.effects ?? new EffectRegistry(),
    commands: options.commands ?? controllerWith("all"),
    t,
    toolAcceptsPaste: () => options.toolAcceptsPaste ?? false,
  };
}

/** Every item in a menu, including the ones inside groups. */
function allItems(entries: readonly MenuEntry[]): MenuItemEntry[] {
  return entries.flatMap((entry) => {
    if (entry.kind === "item") return [entry];
    if (entry.kind === "group") return allItems(entry.entries);
    return [];
  });
}

function item(entries: readonly MenuEntry[], label: string): MenuItemEntry {
  const found = allItems(entries).find((entry) => plainLabel(entry.label) === label);
  if (found === undefined) throw new Error(`No item "${label}".`);
  return found;
}

function group(entries: readonly MenuEntry[], label: string) {
  const found = entries.find(
    (entry) => entry.kind === "group" && plainLabel(entry.label) === label,
  );
  if (found === undefined || found.kind !== "group") throw new Error(`No group "${label}".`);
  return found;
}

describe("access keys and titles", () => {
  it("splits a label at the character after the first ampersand", () => {
    expect(splitAccessKey("&New...")).toEqual({ before: "", accessKey: "N", after: "ew..." });
    expect(splitAccessKey("Cu&t")).toEqual({ before: "Cu", accessKey: "t", after: "" });
    expect(splitAccessKey('Invert ("&xor")')).toEqual({
      before: 'Invert ("',
      accessKey: "x",
      after: 'or")',
    });
  });

  it("returns no access key when there is none or the ampersand is last", () => {
    expect(splitAccessKey("Plain").accessKey).toBeUndefined();
    expect(splitAccessKey("End&")).toEqual({ before: "End&", after: "" });
    expect(plainLabel("Save A&ll")).toBe("Save All");
  });

  it("lists the seven main menus in the spec's order with their access keys", () => {
    expect(MENU_NAMES).toEqual([
      "file",
      "edit",
      "view",
      "image",
      "layers",
      "adjustments",
      "effects",
    ]);
    expect(plainLabel(menuTitle("effects", t))).toBe("Effects");
    expect(splitAccessKey(menuTitle("effects", t)).accessKey).toBe("c");
    expect(splitAccessKey(menuTitle("file", t)).accessKey).toBe("F");
  });
});

describe("File, Edit, View, Image and Layers", () => {
  it("opens with New and Open enabled and everything document-based off", () => {
    const file = buildMenu("file", context());
    expect(item(file, "New...").enabled).toBe(true);
    expect(item(file, "Open...").enabled).toBe(true);
    expect(item(file, "Save").enabled).toBe(false);
    expect(item(file, "Save As...").enabled).toBe(false);
    expect(item(file, "Save All").enabled).toBe(false);
    expect(item(file, "Print...").enabled).toBe(false);
    expect(item(file, "Close").enabled).toBe(false);
  });

  it("puts separators where the spec's table has them", () => {
    const file = buildMenu("file", context());
    expect(file.map((entry) => entry.kind)).toEqual([
      "item",
      "item",
      "group",
      "separator",
      "item",
      "item",
      "item",
      "separator",
      "item",
      "separator",
      "item",
      "item",
    ]);
  });

  it("enables Save and Save All from the document and unsaved state", () => {
    const file = buildMenu("file", context({ hasDocument: true, anyUnsaved: true }));
    expect(item(file, "Save").enabled).toBe(true);
    expect(item(file, "Save All").enabled).toBe(true);
  });

  it("leaves Save As out where it would only repeat Save (owner request)", () => {
    const labels = (offered: boolean | undefined) =>
      buildMenu("file", context({ hasDocument: true, saveAsOffered: offered })).flatMap((entry) =>
        entry.kind === "item" ? [entry.label.replaceAll("&", "")] : [],
      );
    expect(labels(true)).toContain("Save As...");
    expect(labels(undefined)).toContain("Save As...");
    expect(labels(false)).not.toContain("Save As...");
    expect(labels(false)).toContain("Save");
  });

  it("gates Undo and Redo on the history, and Undo needs more than the base entry", () => {
    const edit = buildMenu("edit", context({ hasDocument: true, canUndo: true }));
    expect(item(edit, "Undo").enabled).toBe(true);
    expect(item(edit, "Redo").enabled).toBe(false);
    const none = buildMenu("edit", context({ hasDocument: true, canUndo: false }));
    expect(item(none, "Undo").enabled).toBe(false);
  });

  it("gates the clipboard items on the clipboard and the document", () => {
    const withImage = buildMenu("edit", context({ clipboardHasImage: true }));
    expect(item(withImage, "Paste into New Image").enabled).toBe(true);
    expect(item(withImage, "Paste").enabled).toBe(false);
    expect(item(withImage, "Paste into New Layer").enabled).toBe(false);

    const open = buildMenu("edit", context({ hasDocument: true, clipboardHasImage: true }));
    expect(item(open, "Paste").enabled).toBe(true);
    expect(item(open, "Paste into New Layer").enabled).toBe(true);
  });

  it("enables Paste when the active tool takes pasted text (the Paste fallback)", () => {
    const text = buildMenu("edit", context({ hasDocument: true }, { toolAcceptsPaste: true }));
    expect(item(text, "Paste").enabled).toBe(true);
    expect(item(text, "Paste into New Layer").enabled).toBe(false);
    const none = buildMenu("edit", context({ hasDocument: true }));
    expect(item(none, "Paste").enabled).toBe(false);
  });

  it("gates the selection items on a non-empty selection", () => {
    const none = buildMenu("edit", context({ hasDocument: true }));
    expect(item(none, "Cut").enabled).toBe(false);
    expect(item(none, "Copy Selection").enabled).toBe(false);
    expect(item(none, "Erase Selection").enabled).toBe(false);
    expect(item(none, "Deselect").enabled).toBe(false);
    expect(item(none, "Fill Selection").enabled).toBe(true);
    expect(item(none, "Select All").enabled).toBe(true);

    const selected = buildMenu(
      "edit",
      context({ hasDocument: true, hasSelection: true, activeLayerIsBitmap: true }),
    );
    expect(item(selected, "Cut").enabled).toBe(true);
    expect(item(selected, "Erase Selection").enabled).toBe(true);
    expect(item(selected, "Deselect").enabled).toBe(true);
  });

  it("puts the five Paste Selection modes in a submenu gated on the clipboard outline", () => {
    const edit = buildMenu("edit", context({ hasDocument: true, clipboardHasSelection: true }));
    const submenu = group(edit, "Paste Selection");
    expect(
      submenu.entries.map((entry) => plainLabel(entry.kind === "item" ? entry.label : "")),
    ).toEqual(["Replace", "Add (union)", "Exclude", "Intersect", 'Invert ("xor")']);
    expect(allItems(submenu.entries).every((entry) => entry.enabled)).toBe(true);
    const none = buildMenu("edit", context({ hasDocument: true }));
    expect(allItems(group(none, "Paste Selection").entries).some((entry) => entry.enabled)).toBe(
      false,
    );
  });

  it("gates the View zoom and checked states on the document and the view", () => {
    const view = buildMenu(
      "view",
      context({
        hasDocument: true,
        view: {
          fitToWindow: true,
          pixelGrid: false,
          rulers: true,
          units: "inches",
          fullScreen: false,
        },
      }),
    );
    expect(item(view, "Zoom to Window").checked).toBe(true);
    expect(item(view, "Rulers").checked).toBe(true);
    expect(item(view, "Pixel grid").checked).toBe(false);
    expect(item(view, "Inches").checked).toBe(true);
    expect(item(view, "Pixels").checked).toBe(false);
    expect(item(view, "Zoom to Selection").enabled).toBe(false);
    expect(item(view, "Full Screen").enabled).toBe(false);
  });

  it("enables Full Screen only when the Fullscreen API is available", () => {
    const view = buildMenu("view", context({ fullScreenAvailable: true }));
    expect(item(view, "Full Screen").enabled).toBe(true);
  });

  it("gates Crop, Flatten and the rotations on the image", () => {
    const one = buildMenu("image", context({ hasDocument: true, layerCount: 1 }));
    expect(item(one, "Crop to Selection").enabled).toBe(false);
    expect(item(one, "Resize...").enabled).toBe(true);
    expect(item(one, "Flatten").enabled).toBe(false);
    expect(item(one, "Rotate 180°").enabled).toBe(true);

    const many = buildMenu(
      "image",
      context({ hasDocument: true, hasSelection: true, layerCount: 3 }),
    );
    expect(item(many, "Crop to Selection").enabled).toBe(true);
    expect(item(many, "Flatten").enabled).toBe(true);
  });

  it("uses the index counted from the bottom for the layer navigation rules", () => {
    const bottom = buildMenu(
      "layers",
      context({ hasDocument: true, layerCount: 3, activeLayerIndex: 0 }),
    );
    expect(item(bottom, "Delete Layer").enabled).toBe(true);
    expect(item(bottom, "Merge Layer Down").enabled).toBe(false);
    expect(item(bottom, "Move Layer Up").enabled).toBe(true);
    expect(item(bottom, "Move Layer Down").enabled).toBe(false);
    expect(item(bottom, "Go to Top Layer").enabled).toBe(true);
    expect(item(bottom, "Go to Bottom Layer").enabled).toBe(false);

    const top = buildMenu(
      "layers",
      context({ hasDocument: true, layerCount: 3, activeLayerIndex: 2 }),
    );
    expect(item(top, "Move Layer to Top").enabled).toBe(false);
    expect(item(top, "Go to Layer Below").enabled).toBe(true);
    expect(item(top, "Merge Layer Down").enabled).toBe(true);

    const single = buildMenu("layers", context({ hasDocument: true, layerCount: 1 }));
    expect(item(single, "Delete Layer").enabled).toBe(false);
  });
});

describe("shortcuts and enable states from the command system", () => {
  it("shows the platform shortcut labels from the catalog", () => {
    const edit = buildMenu("edit", context({ hasDocument: true, canUndo: true }));
    expect(item(edit, "Undo").shortcut).toBe("Ctrl+Z");
    expect(item(edit, "Fill Selection").shortcut).toBe("Backspace");
    expect(item(edit, "Erase Selection").shortcut).toBe("Delete");
    const file = buildMenu("file", context());
    expect(item(file, "Save As...").shortcut).toBe("Ctrl+Shift+S");
    const view = buildMenu("view", context());
    expect(item(view, "Zoom In").shortcut).toBe("Ctrl++");
    expect(item(view, "Zoom Out").shortcut).toBe("Ctrl+-");
    const image = buildMenu("image", context());
    expect(item(image, "Rotate 90° Clockwise").shortcut).toBe("Ctrl+H");
    expect(item(image, "Rotate 180°").shortcut).toBeUndefined();
  });

  it("disables an item whose command has no handler, even when its rule holds", () => {
    const edit = buildMenu(
      "edit",
      context({ hasDocument: true, canUndo: true }, { commands: controllerWith([]) }),
    );
    expect(item(edit, "Undo").enabled).toBe(false);
  });

  it("enables an item once its handler is registered and its rule holds", () => {
    const edit = buildMenu(
      "edit",
      context({ hasDocument: true, canUndo: true }, { commands: controllerWith(["edit.undo"]) }),
    );
    expect(item(edit, "Undo").enabled).toBe(true);
  });
});

describe("Adjustments and Effects from the registry", () => {
  function registryWithBlur(): EffectRegistry {
    const effects = new EffectRegistry();
    registerBuiltinEffects(effects, 1);
    return effects;
  }

  it("lists Gaussian Blur under its submenu with the ellipsis, and keeps the adjustments out of it", () => {
    const menu = buildMenu("effects", context({}, { effects: registryWithBlur() }));
    const blurs = group(menu, "Blurs");
    expect(item(blurs.entries, "Gaussian Blur...").enabled).toBe(false);
    expect(allItems(menu).map((entry) => entry.label)).not.toContain("Sepia...");
  });

  it("lists the built-in adjustments flat, with their catalog shortcuts (ADJ-MENU-03, ADJ-MENU-04)", () => {
    const adjustments = buildMenu(
      "adjustments",
      context({ hasDocument: true, canRunEffects: true }, { effects: registryWithBlur() }),
    );
    expect(adjustments.every((entry) => entry.kind === "item")).toBe(true);
    expect(item(adjustments, "Black and White").shortcut).toBe("Ctrl+Shift+G");
    expect(item(adjustments, "Invert Alpha").shortcut).toBe("Ctrl+Alt+I");
    expect(item(adjustments, "Invert Colors").shortcut).toBe("Ctrl+Shift+I");
    expect(item(adjustments, "Sepia...").shortcut).toBe("Ctrl+Shift+E");
    expect(item(adjustments, "Sepia...").action).toEqual({ type: "effect", effect: "sepia" });
    expect(item(adjustments, "Invert Colors").enabled).toBe(true);
  });

  it("builds the Adjustments menu from the adjustment category with the catalog shortcut", () => {
    const effects = new EffectRegistry();
    effects.register({ ...gaussianBlurDescriptor(1), id: "levels", category: "adjustment" });
    const adjustments = buildMenu(
      "adjustments",
      context({ hasDocument: true, canRunEffects: true }, { effects }),
    );
    const levels = item(adjustments, "Gaussian Blur...");
    expect(levels.shortcut).toBe("Ctrl+L");
    expect(levels.enabled).toBe(true);
    expect(levels.action).toEqual({ type: "effect", effect: "levels" });
    expect(buildMenu("effects", context({}, { effects }))).toEqual([]);
  });

  it("keeps effect items disabled until effects can run on a document", () => {
    const effects = registryWithBlur();
    const noDoc = buildMenu("effects", context({ canRunEffects: true }, { effects }));
    expect(item(noDoc, "Gaussian Blur...").enabled).toBe(false);
    const noRun = buildMenu("effects", context({ hasDocument: true }, { effects }));
    expect(item(noRun, "Gaussian Blur...").enabled).toBe(false);
    const ready = buildMenu(
      "effects",
      context({ hasDocument: true, canRunEffects: true }, { effects }),
    );
    expect(item(ready, "Gaussian Blur...").enabled).toBe(true);
  });

  it("puts Repeat with its name and Ctrl+F first, after an effect has run", () => {
    const effects = registryWithBlur();
    const before = buildMenu("effects", context({}, { effects }));
    expect(before[0]?.kind).toBe("group");

    const repeated = buildMenu(
      "effects",
      context(
        { hasDocument: true, canRunEffects: true, lastEffectId: GAUSSIAN_BLUR_ID },
        { effects, commands: controllerWith(["effects.repeat"]) },
      ),
    );
    const repeat = repeated[0];
    expect(repeat?.kind).toBe("item");
    expect(repeat?.kind === "item" && repeat.label).toBe("Repeat Gaussian Blur");
    expect(repeat?.kind === "item" && repeat.shortcut).toBe("Ctrl+F");
    expect(repeat?.kind === "item" && repeat.enabled).toBe(true);
    expect(repeated[1]?.kind).toBe("separator");
  });

  it("leaves Repeat out when the remembered effect is no longer registered", () => {
    const menu = buildMenu(
      "effects",
      context({ lastEffectId: "missing", hasDocument: true, canRunEffects: true }),
    );
    expect(menu.some((entry) => entry.kind === "item" && entry.label.startsWith("Repeat"))).toBe(
      false,
    );
  });
});

describe("Help menu and omitted items", () => {
  it("holds only Keyboard Shortcuts and About, each enabled once it has a handler (owner request)", () => {
    const help = buildHelpMenu(
      context({}, { commands: controllerWith(["help.keyboardShortcuts"]) }),
    );
    expect(
      help.map((entry) => (entry.kind === "item" ? plainLabel(entry.label) : entry.kind)),
    ).toEqual(["Keyboard Shortcuts", "About"]);
    expect(item(help, "Keyboard Shortcuts").enabled).toBe(true);
    expect(item(help, "About").enabled).toBe(false);
  });

  it("leaves out the [LATER] items", () => {
    const effects = new EffectRegistry();
    registerBuiltinEffects(effects, 1);
    const labels = [
      ...MENU_NAMES.flatMap((name) => allItems(buildMenu(name, context({}, { effects })))),
      ...allItems(buildHelpMenu(context())),
    ].map((entry) => plainLabel(entry.label));
    for (const omitted of ["Color Profile...", "Plugin Errors...", "Language..."]) {
      expect(labels).not.toContain(omitted);
    }
  });
});

describe("Open Recent (FMT-OPEN-06)", () => {
  it("lists the entries with their thumbnails, then Clear this list", () => {
    const recent = [
      { id: 2, name: "b.png", thumbnail: "data:image/png;base64,BBBB" },
      { id: 1, name: "a&.png" },
    ];
    const list = group(buildMenu("file", context({ recent })), "Open Recent");
    const items = allItems(list.entries);

    expect(items.map((entry) => plainLabel(entry.label))).toEqual([
      "b.png",
      "a.png",
      "Clear this list",
    ]);
    expect(items[0]?.thumbnail).toBe("data:image/png;base64,BBBB");
    expect(items[0]?.action).toEqual({ type: "recent", id: 2 });
    expect(items[1]?.thumbnail).toBeUndefined();
    expect(items[2]?.enabled).toBe(true);
  });

  it("shows (none) and disables Clear this list when the list is empty", () => {
    const list = group(buildMenu("file", context()), "Open Recent");
    const items = allItems(list.entries);

    expect(plainLabel(items[0]?.label ?? "")).toBe("(none)");
    expect(items[0]?.enabled).toBe(false);
    expect(item(list.entries, "Clear this list").enabled).toBe(false);
  });

  it("enables Save All only when an image has unsaved changes", () => {
    expect(item(buildMenu("file", context({ hasDocument: true })), "Save All").enabled).toBe(false);
    expect(
      item(buildMenu("file", context({ hasDocument: true, anyUnsaved: true })), "Save All").enabled,
    ).toBe(true);
  });
});

describe("menu state", () => {
  it("starts with no image, so only the rules that do not need one are enabled", () => {
    expect(NO_IMAGE_MENU_STATE.hasDocument).toBe(false);
    const entries = MENU_NAMES.flatMap((name) => allItems(buildMenu(name, context())));
    const enabled = entries
      .filter((entry) => entry.enabled)
      .map((entry) => plainLabel(entry.label));
    expect(enabled).toEqual(["New...", "Open..."]);
  });
});

describe("common-actions strip (UI-TB-01)", () => {
  const actions = (state: Partial<MenuState>, toolAcceptsPaste = false) =>
    commonActions(context(state, { toolAcceptsPaste })).flatMap((entry) =>
      entry.kind === "action" ? [entry] : [],
    );
  const byId = (state: Partial<MenuState>, id: BuiltInCommandId) => {
    const found = actions(state).find((entry) => entry.id === id);
    if (found === undefined) throw new Error(`No button "${id}".`);
    return found;
  };

  it("lists the buttons in spec order, grouped by separators, with the action names as tooltips", () => {
    const entries = commonActions(context());
    expect(entries.map((entry) => (entry.kind === "action" ? entry.name : "|"))).toEqual([
      "New",
      "Open",
      "Save",
      "Save All",
      "|",
      "Print",
      "|",
      "Cut",
      "Copy",
      "Paste",
      "Crop to Selection",
      "Deselect",
      "|",
      "Undo",
      "Redo",
      "|",
      "Display pixel grid when zoomed in",
      "Rulers",
    ]);
    expect(byId({}, "edit.undo").shortcut).toBe("Ctrl+Z");
  });

  it("enables each button exactly when its menu item is enabled", () => {
    const states: Partial<MenuState>[] = [
      {},
      { hasDocument: true },
      { hasDocument: true, hasSelection: true, activeLayerIsBitmap: true, canUndo: true },
      { hasDocument: true, canRedo: true, clipboardHasImage: true, anyUnsaved: true },
    ];
    for (const state of states) {
      const menuItems = new Map(
        (["file", "edit", "view", "image"] as const)
          .flatMap((name) => allItems(buildMenu(name, context(state))))
          .map((entry) => [entry.id, entry]),
      );
      for (const action of actions(state)) {
        expect(action.enabled).toBe(menuItems.get(action.id)?.enabled);
        expect(action.checked).toBe(menuItems.get(action.id)?.checked);
      }
    }
  });

  it("keeps New and Open on with no image open and the image buttons off", () => {
    const none = actions({});
    const enabled = none.filter((entry) => entry.enabled).map((entry) => entry.id);
    expect(enabled).toEqual(["file.new", "file.open"]);
  });

  it("enables Deselect and Crop to Selection only with a selection, and shows the grid toggle state", () => {
    expect(byId({ hasDocument: true }, "edit.deselect").enabled).toBe(false);
    expect(byId({ hasDocument: true }, "image.crop").enabled).toBe(false);
    const selected = { hasDocument: true, hasSelection: true };
    expect(byId(selected, "edit.deselect").enabled).toBe(true);
    expect(byId(selected, "image.crop").enabled).toBe(true);
    const grid = byId(
      { hasDocument: true, view: { ...NO_IMAGE_MENU_STATE.view, pixelGrid: true } },
      "view.pixelGrid",
    );
    expect(grid).toMatchObject({ toggle: true, checked: true, enabled: true });
  });
});
