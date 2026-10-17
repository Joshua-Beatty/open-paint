import { EffectRegistry } from "@openpaint/extension-api";
import { t } from "@openpaint/i18n";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BUILT_IN_REGISTRY, type BuiltInCommandId } from "../commands/catalog";
import { platformFromName } from "../commands/keys";
import { ShortcutController } from "../commands/shortcuts";
import { type MenuContext, NO_IMAGE_MENU_STATE, plainLabel } from "../menus/menu-model";
import { CompactMenu, compactMenuEntries } from "./CompactMenu";

function context(): { context: MenuContext; ran: BuiltInCommandId[] } {
  const commands = new ShortcutController(BUILT_IN_REGISTRY, platformFromName("Win32"));
  const ran: BuiltInCommandId[] = [];
  commands.register("edit.settings", { run: () => void ran.push("edit.settings") });
  return {
    ran,
    context: {
      state: NO_IMAGE_MENU_STATE,
      effects: new EffectRegistry(),
      commands,
      t,
      toolAcceptsPaste: () => false,
    },
  };
}

afterEach(cleanup);

describe("CompactMenu", () => {
  it("lists every main menu as a submenu, then Help and Settings", () => {
    const entries = compactMenuEntries(context().context);
    const labels = entries.map((entry) =>
      entry.kind === "separator" ? "-" : plainLabel(entry.label),
    );
    expect(labels).toEqual([
      "File",
      "Edit",
      "View",
      "Image",
      "Layers",
      "Adjustments",
      "Effects",
      "-",
      "Help",
      "Settings",
    ]);
    const file = entries[0];
    expect(file?.kind === "group" && file.entries.length > 0).toBe(true);
  });

  it("opens from its button and runs Settings", () => {
    const { context: menu, ran } = context();
    render(
      <CompactMenu
        context={menu}
        actions={{ onCommand: (id) => menu.commands.isEnabled(id) && ran.push(id) }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Settings/ }));
    expect(ran).toEqual(["edit.settings"]);
  });
});
